"""`logless rebuild [--limit N] [--from-stage S]` — run the pipeline and publish a snapshot atomically.

Stages run in order; each writes a run record {stage, started_at, finished_at, counts, models} into
`builds.stages_json` (and later the snapshot provenance). `--from-stage` resumes the latest build
from that stage (earlier artifacts are reused); without it a new build starts. Per-conversation
work (facets, friction) is shared across builds and skips rows already done.

Stage order note: `stats` runs after the privacy gate because a gate roll-up changes the leaf
structure; the describe stage uses private per-leaf friction counts only as evidence."""
from __future__ import annotations

import importlib
import json
import logging
import time
import traceback

from .. import db
from ..config import EMBEDDING_MODEL, GLM, GLM_FLASH, JEV
from ..ids import build_id as new_build_id
from ..ids import utcnow
from ..providers.http import ProviderError
from . import util

log = logging.getLogger("logless.pipeline")

PIPELINE_VERSION = "1.0.0"

# (stage name, module, models used)
STAGES: list[tuple[str, str, list[str]]] = [
    ("facets", "facets", [GLM_FLASH, JEV]),
    ("discover", "discover", [EMBEDDING_MODEL, GLM]),
    ("classify", "classify", [JEV]),
    ("leftovers", "leftovers", [EMBEDDING_MODEL, GLM, JEV]),
    ("hierarchy", "hierarchy", [GLM, JEV]),
    ("describe", "describe", [GLM]),
    ("gate", "gate", [GLM, JEV]),
    ("labels", "labels", [GLM, JEV]),
    ("surprising", "surprising", [JEV]),
    ("stats", "stats", []),
    ("publish", "publish", []),
]
STAGE_NAMES = [s[0] for s in STAGES]


def scope(limit: int | None) -> list[str]:
    """The build's conversations: the sample (+ fixtures), never live-intake batches."""
    from ..intake import ensure_schema
    ensure_schema()
    con = db.private()
    if limit:
        rows = con.execute("SELECT conv_id FROM conversations WHERE intake_batch IS NULL AND (is_fixture = 1 OR sample_rank < ?)"
                           " ORDER BY conv_id", (limit,)).fetchall()
    else:
        rows = con.execute("SELECT conv_id FROM conversations WHERE intake_batch IS NULL ORDER BY conv_id").fetchall()
    return [r["conv_id"] for r in rows]


def _save_build(b: util.Build, status: str, finished: bool = False) -> None:
    con = db.private()
    with db.write(con):
        con.execute(
            "INSERT INTO builds(build_id, started_at, finished_at, status, stages_json, snapshot_id) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(build_id) DO UPDATE SET finished_at=excluded.finished_at, status=excluded.status,"
            " stages_json=excluded.stages_json, snapshot_id=COALESCE(excluded.snapshot_id, builds.snapshot_id)",
            (b.build_id, b.started_at, utcnow() if finished else None, status, json.dumps(b.stages),
             b.info.get("snapshot_id")))
    b.save("build", {"build_id": b.build_id, "limit": b.limit, "started_at": b.started_at, "info": b.info,
                     "usage": build_usage(b)})


def build_usage(b: util.Build) -> list[dict]:
    """Usage rows of earlier runs of this build (when resumed) + this process."""
    return list(b.info.get("_usage_prev", [])) + util.USAGE.summary()


def load_build(build_id: str | None = None) -> util.Build:
    """A given build; else the latest build if it is unfinished (running or failed: resume it); else the
    build behind the current public snapshot; else the latest build."""
    con = db.private()
    row = None
    if build_id:
        row = con.execute("SELECT * FROM builds WHERE build_id = ?", (build_id,)).fetchone()
    else:
        latest = con.execute("SELECT * FROM builds WHERE status IS NULL OR status NOT IN ('abandoned')"
                             " ORDER BY build_id DESC LIMIT 1").fetchone()
        if latest is not None and (latest["status"] or "").split(":")[0] in ("running", "failed", "ok", ""):
            row = latest
    if row is None and not build_id:
        cur = db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current = 1").fetchone()
        if cur is not None:
            from ..intake import build_of_snapshot  # an intake snapshot resolves to its base build
            bid = build_of_snapshot(cur["snapshot_id"])
            if bid:
                row = con.execute("SELECT * FROM builds WHERE build_id = ?", (bid,)).fetchone()
        if row is None:
            row = con.execute("SELECT * FROM builds ORDER BY build_id DESC LIMIT 1").fetchone()
    if row is None:
        raise SystemExit("no build to resume; run `logless rebuild` without --from-stage")
    b = util.Build(build_id=row["build_id"], limit=None, conv_ids=[], started_at=row["started_at"],
                   stages=json.loads(row["stages_json"] or "[]"))
    meta = b.load("build", {})
    b.limit = meta.get("limit")
    b.info = meta.get("info", {})
    b.info["_usage_prev"] = meta.get("usage", [])
    b.conv_ids = b.load("scope")
    return b


def run_stage(b: util.Build, name: str) -> None:
    mod_name, models = next((m, ms) for n, m, ms in STAGES if n == name)
    mod = importlib.import_module(f"logless.pipeline.{mod_name}")
    util.USAGE.stage = name
    started = utcnow()
    t0 = time.monotonic()
    log.info("stage %s: start (build %s, %d conversations)", name, b.build_id, len(b.conv_ids))
    counts = mod.run(b) or {}
    if util.no_cache():
        counts["fresh_model_calls"] = 1  # llm/embedding cache reads were disabled for this stage
    rec = {"stage": name, "started_at": started, "finished_at": utcnow(),
           "counts": {k: int(v) for k, v in counts.items() if isinstance(v, (int, float, bool))},
           "models": list(b.info.pop("_stage_models", None) or models)}
    b.stages = [s for s in b.stages if s["stage"] != name] + [rec]
    b.info.setdefault("stage_seconds", {})[name] = round(time.monotonic() - t0, 1)
    _save_build(b, f"running:{name}")
    log.info("stage %s: done in %.1fs %s", name, time.monotonic() - t0, rec["counts"])


def main(limit: int | None = None, from_stage: str | None = None, until: str | None = None,
         no_cache: bool = False) -> int:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if no_cache:
        import os
        os.environ["LOGLESS_NO_CACHE"] = "1"
    if util.no_cache():
        log.info("no-cache mode: fresh model and embedding calls; facets and friction are recomputed")
    if from_stage:
        if from_stage not in STAGE_NAMES:
            raise SystemExit(f"unknown stage {from_stage}; stages: {', '.join(STAGE_NAMES)}")
        import os
        b = load_build(os.environ.get("LOGLESS_BUILD_ID") or None)
        i = STAGE_NAMES.index(from_stage)
        b.stages = [s for s in b.stages if STAGE_NAMES.index(s["stage"]) < i] if b.stages else []
    else:
        b = util.Build(build_id=new_build_id(), limit=limit, conv_ids=scope(limit), started_at=utcnow())
        b.save("scope", b.conv_ids)
        i = 0
        _save_build(b, "running")
    todo = STAGE_NAMES[i:]
    if until:
        todo = todo[: todo.index(until) + 1]
    log.info("build %s: stages %s", b.build_id, ",".join(todo))
    try:
        for name in todo:
            run_stage(b, name)
    except (util.ProviderUnavailable, ProviderError) as e:
        msg = e.describe() if isinstance(e, ProviderError) else str(e)
        log.error("build %s failed in stage %s: %s", b.build_id, util.USAGE.stage, msg)
        _save_build(b, f"failed:{util.USAGE.stage}", finished=True)
        raise SystemExit(f"stage {util.USAGE.stage} failed: {msg}. Resume with: logless rebuild "
                         f"--from-stage {util.USAGE.stage} (build {b.build_id})")
    except Exception as e:
        log.error("build %s failed in stage %s: %s", b.build_id, util.USAGE.stage, type(e).__name__)
        log.debug("%s", traceback.format_exc())
        _save_build(b, f"failed:{util.USAGE.stage}", finished=True)
        # re-raise for a visible traceback on the operator console (no data in it)
        raise
    _save_build(b, "published" if "publish" in todo else f"ok:{todo[-1]}", finished="publish" in todo)
    usage = build_usage(b)
    total = sum(u["usd"] or 0 for u in usage)
    log.info("build %s finished; estimated GLM cost $%.3f", b.build_id, total)
    return 0
