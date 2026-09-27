"""Live intake (docs/CONTRACTS.md §11): ingest a prepared batch of NEW WildChat conversations into the
published map in real time, with real model decisions and a real, gated, atomic snapshot update.

- `prepare(n, seed)` (operator CLI, before the demo): pick N conversations of the pinned shard that are
  not in the sample, store them with `conversations.intake_batch`, and run GLM facets + the PII check for
  them now (the slow, rate-limited part). The batch is `ready`.
- `IntakeRun` / `run_batch(...)`: the live part. One Jev call per conversation with 5 questions (the four
  friction signals + a theme Choice over the current snapshot's leaves and "Other or unclear"), 24-way
  concurrency, cutoff 0.65, never served from cache. An event is emitted as each answer lands. Then the
  decisions are filed, the updated snapshot (base build texts, metrics recomputed by the pipeline's
  trusted code over base + batch) passes the deterministic privacy gate, invariants, leak scans and the
  API serializer, and is published atomically; its evaluation report is regenerated in the background.
- `reset()`: re-publish the base snapshot and clear the batch's decisions (idempotent), so the demo can be
  rehearsed.

Presenter-only events carry routing diagnostics, never conversation ids, user ids, raw text, or
per-conversation facet summaries. A PII check alone does not make a summary safe to disclose."""
from __future__ import annotations

import json
import logging
import random
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Callable

from . import db
from .config import JEV, JEV_CONFIDENCE_CUTOFF, settings
from .ids import conversation_id, run_id as new_run_id, user_pseudonym, utcnow

log = logging.getLogger("logless.intake")

INTAKE_ROUND = 100          # assignments.round marker for intake decisions
SUMMARY_MAX = 90
STAGES = ["deciding", "filing", "gating", "publishing", "evaluating"]
OTHER_LEAF = "cl_other"

SCHEMA = """
CREATE TABLE IF NOT EXISTS intake_batches (
  batch_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  n INTEGER NOT NULL,
  seed INTEGER,
  status TEXT NOT NULL,              -- preparing | ready | ingested
  base_snapshot_id TEXT,
  base_build_id TEXT,
  prepared_at TEXT,
  ingested_snapshot_id TEXT,
  ingested_at TEXT
);
"""


class _Aborted(Exception):
    pass


class IntakeError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- schema + batch lookup

def ensure_schema() -> None:
    con = db.private()
    cols = {r["name"] for r in con.execute("PRAGMA table_info(conversations)")}
    if "intake_batch" not in cols:
        with db.write(con):
            con.execute("ALTER TABLE conversations ADD COLUMN intake_batch TEXT")
    con.executescript(SCHEMA)


def current_batch() -> dict | None:
    ensure_schema()
    row = db.private().execute("SELECT * FROM intake_batches ORDER BY created_at DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def batch_conv_ids(batch_id: str) -> list[str]:
    return [r["conv_id"] for r in db.private().execute(
        "SELECT conv_id FROM conversations WHERE intake_batch = ? ORDER BY conv_id", (batch_id,))]


def current_snapshot() -> dict | None:
    row = db.public().execute("SELECT json FROM snapshots WHERE is_current = 1 ORDER BY created_at DESC LIMIT 1").fetchone()
    return json.loads(row["json"]) if row else None


def snapshot_json(snapshot_id: str) -> dict | None:
    row = db.public().execute("SELECT json FROM snapshots WHERE snapshot_id = ?", (snapshot_id,)).fetchone()
    return json.loads(row["json"]) if row else None


def build_of_snapshot(snapshot_id: str) -> str | None:
    """The pipeline build behind a snapshot: its own build, or (for an intake snapshot) the base build."""
    con = db.private()
    row = con.execute("SELECT build_id FROM builds WHERE snapshot_id = ? ORDER BY build_id DESC LIMIT 1",
                      (snapshot_id,)).fetchone()
    if row:
        return row["build_id"]
    ensure_schema()
    row = con.execute("SELECT base_build_id FROM intake_batches WHERE ingested_snapshot_id = ?", (snapshot_id,)).fetchone()
    return row["base_build_id"] if row else None


def is_intake_snapshot(snapshot_id: str) -> bool:
    ensure_schema()
    return db.private().execute("SELECT 1 FROM intake_batches WHERE ingested_snapshot_id = ?",
                                (snapshot_id,)).fetchone() is not None


def status() -> dict:
    """Operator/public status. `ready` means a prepared batch can be ingested into the current snapshot."""
    b = current_batch()
    snap = current_snapshot()
    if b is None:
        return {"ready": False, "batch_size": 0, "base_snapshot_id": None}
    ids = batch_conv_ids(b["batch_id"])
    have = util_count("SELECT COUNT(*) FROM facets WHERE conv_id IN ({})", ids)
    ready = (b["status"] == "ready" and have == len(ids) and len(ids) > 0 and snap is not None
             and not is_intake_snapshot(snap["snapshot_id"]) and build_of_snapshot(snap["snapshot_id"]) is not None)
    return {"ready": ready, "batch_size": len(ids),
            "base_snapshot_id": snap["snapshot_id"] if ready else b.get("base_snapshot_id")}


def recover_interrupted_publication() -> bool:
    """At process startup only: abandon private staging that never became a public snapshot.

    Do not call this concurrently with a live intake run. The public commit is authoritative:
    if the staged snapshot exists, leave it and its inputs intact even after a progress-write crash.
    """
    batch = current_batch()
    if not batch or batch["status"] != "ingested" or not batch.get("ingested_snapshot_id"):
        return False
    if snapshot_json(batch["ingested_snapshot_id"]) is not None:
        return False
    current = current_snapshot()
    if not current or current["snapshot_id"] != batch.get("base_snapshot_id"):
        return False  # an unrelated operator publication is not ours to undo
    _clear_decisions(batch.get("base_build_id"), batch_conv_ids(batch["batch_id"]))
    con = db.private()
    with db.write(con):
        con.execute("UPDATE intake_batches SET status='ready', ingested_snapshot_id=NULL, ingested_at=NULL"
                    " WHERE batch_id=?", (batch["batch_id"],))
    return True


def util_count(sql: str, ids: list[str]) -> int:
    n = 0
    con = db.private()
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        n += con.execute(sql.format(",".join("?" * len(chunk))), chunk).fetchone()[0]
    return n


# ---------------------------------------------------------------- prepare

def prepare(n: int = 300, seed: int | None = None) -> dict:
    """Pick N shard conversations outside the sample, store them as a batch, and extract their facets."""
    import pyarrow.parquet as pq

    from .data import wildchat
    from .pipeline import facets as facets_stage
    from .pipeline import util

    if type(n) is not int or not 1 <= n <= 5000:
        raise IntakeError("invalid_batch_size", "batch size must be between 1 and 5000")
    from .data.importer import metadata
    if metadata() is not None:
        raise IntakeError("unsupported_intake_source", "Live intake uses the WildChat adapter; prepare a separate imported workspace.")
    ensure_schema()
    snap = current_snapshot()
    if snap is not None and is_intake_snapshot(snap["snapshot_id"]):
        raise IntakeError("intake_published", "an intake snapshot is live; run `logless intake reset` first")
    _drop_batches()
    s = settings()
    seed = seed if seed is not None else s.sample_seed + 1
    table = pq.read_table(wildchat.download(), columns=wildchat.COLUMNS)
    convs = table.column("conversation").to_pylist()
    con = db.private()
    sampled = {r[0] for r in con.execute("SELECT source_row FROM conversations WHERE source_row IS NOT NULL")}
    existing = {r[0] for r in con.execute("SELECT conv_id FROM conversations")}
    eligible = [i for i, c in enumerate(convs)
                if i not in sampled and c and c[0].get("role") == "user" and (c[0].get("content") or "").strip()]
    rng = random.Random(seed)
    rng.shuffle(eligible)
    cols = {name: table.column(name).to_pylist() for name in wildchat.COLUMNS if name != "conversation"}
    batch_id = "ib_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    rows = []
    for i in eligible:
        if len(rows) >= n:
            break
        conv = convs[i]
        cid = conversation_id(conv[0]["turn_identifier"])
        if cid in existing:
            continue
        ts = cols["timestamp"][i]
        rows.append((cid, int(conv[0]["turn_identifier"]), i, None,
                     user_pseudonym(cols["hashed_ip"][i] or f"missing-{i}", s.pseudonym_salt),
                     cols["language"][i], int(cols["turn"][i]), cols["model"][i], cols["country"][i],
                     ts.isoformat() if ts is not None else None, wildchat.render(conv), int(wildchat.was_truncated(conv)),
                     batch_id))
        existing.add(cid)
    base_build = build_of_snapshot(snap["snapshot_id"]) if snap else None
    with db.write(con):
        con.execute("INSERT INTO intake_batches(batch_id, created_at, n, seed, status, base_snapshot_id, base_build_id)"
                    " VALUES (?,?,?,?,?,?,?)", (batch_id, utcnow(), len(rows), seed, "preparing",
                                                snap["snapshot_id"] if snap else None, base_build))
        con.executemany(
            "INSERT INTO conversations(conv_id, turn_identifier, source_row, sample_rank, user_id, language, turns, model,"
            " country, ts, text, truncated, is_fixture, intake_batch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)", rows)
    facets_stage.ensure_schema()
    ids = [r[0] for r in rows]
    texts = {r[0]: r[10] for r in rows}
    util.USAGE.stage = "intake-prepare"
    out, errs = util.pmap(lambda c: facets_stage.extract_one(c, texts[c]), ids, s.glm_concurrency, "intake-facets")
    for c, r in zip(ids, out):
        if r is None:
            facets_stage._mark_failed(c)
    with db.write(con):
        con.execute("UPDATE intake_batches SET status = 'ready', prepared_at = ? WHERE batch_id = ?", (utcnow(), batch_id))
    checks = {r["status"] for r in con.execute(
        f"SELECT status FROM facet_checks WHERE conv_id IN ({','.join('?' * len(ids))})", ids)} if ids else set()
    return {"batch_id": batch_id, "batch_size": len(ids), "facet_errors": errs,
            "base_snapshot_id": snap["snapshot_id"] if snap else None, "facet_statuses": sorted(checks),
            "usage": util.USAGE.summary()}


def _drop_batches() -> None:
    """Remove every previous batch (its conversations, facets, decisions). Refuses if one is live."""
    con = db.private()
    olds = [r["batch_id"] for r in con.execute("SELECT batch_id FROM intake_batches")]
    ids = [r["conv_id"] for r in con.execute("SELECT conv_id FROM conversations WHERE intake_batch IS NOT NULL")]
    with db.write(con):
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = ",".join("?" * len(chunk))
            for t in ("assignments", "friction", "facets"):
                con.execute(f"DELETE FROM {t} WHERE conv_id IN ({q})", chunk)
            if _has_table("facet_checks"):
                con.execute(f"DELETE FROM facet_checks WHERE conv_id IN ({q})", chunk)
            con.execute(f"DELETE FROM conversations WHERE conv_id IN ({q})", chunk)
        con.execute("DELETE FROM intake_batches")
    if olds:
        log.info("dropped %d previous intake batch(es)", len(olds))


def _has_table(name: str) -> bool:
    return db.private().execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


# ---------------------------------------------------------------- the live run

def _jev_live(state: Any, questions: dict) -> dict:
    """Live Jev decision: never served from (or written to) the response cache."""
    from .providers import jev
    return jev.ask(state, questions, use_cache=False)


ASK: Callable[[Any, dict], dict] = _jev_live   # tests swap in a deterministic fake


def summary_for(task: str | None, pii_status: str | None) -> str | None:
    """Retained for protocol compatibility; per-conversation text is never released."""
    return None


class IntakeRun:
    """One intake run: a Run record persisted to public.db `runs` (kind "intake") plus an in-memory
    event log for polling."""

    def __init__(self, base_snapshot_id: str, total: int):
        now = utcnow()
        self.lock = threading.Lock()
        self.events: list[dict] = []
        self.latencies: list[float] = []
        self.total = total
        self.decided = 0
        self.t0: float | None = None
        self.stage = "deciding"
        self.state = "running"
        self.doc = {
            "run_id": new_run_id(), "kind": "intake", "intent": None, "snapshot_id": base_snapshot_id,
            "state": "queued", "created_at": now, "updated_at": now,
            "stages": [{"name": s, "status": "pending", "started_at": None, "finished_at": None, "detail": None} for s in STAGES],
            "attempts": 0, "code": None, "receipt": None, "verdict": None, "result": None, "explanation": None,
            "containment": None, "error": None, "question": None, "plan": None, "attempts_log": [], "intake": None,
        }
        self._save(insert=True)

    @property
    def id(self) -> str:
        return self.doc["run_id"]

    def _save(self, insert: bool = False) -> None:
        d = self.doc
        d["updated_at"] = utcnow()
        con = db.public()
        with db.write(con):
            if insert:
                con.execute("INSERT INTO runs(run_id, kind, intent, snapshot_id, state, json, created_at, updated_at)"
                            " VALUES (?,?,?,?,?,?,?,?)", (d["run_id"], d["kind"], d["intent"], d["snapshot_id"],
                                                          d["state"], json.dumps(d), d["created_at"], d["updated_at"]))
            else:
                con.execute("UPDATE runs SET state=?, json=?, updated_at=? WHERE run_id=?",
                            (d["state"], json.dumps(d), d["updated_at"], d["run_id"]))

    def set_stage(self, name: str, status: str, detail: str | None = None) -> None:
        with self.lock:
            for s in self.doc["stages"]:
                if s["name"] == name:
                    s["status"] = status
                    if status == "running":
                        s["started_at"] = utcnow()
                        self.stage = name
                    if status in ("done", "failed", "skipped"):
                        s["finished_at"] = utcnow()
                    if detail is not None:
                        s["detail"] = detail
            if status == "running" and self.doc["state"] not in ("completed", "failed"):
                self.doc["state"] = "executing"
            self._save()

    def add_event(self, ev: dict, latency_s: float) -> None:
        with self.lock:
            self.decided += 1
            self.latencies.append(latency_s)
            ev = {"seq": len(self.events) + 1, "t_ms": int(1000 * (time.monotonic() - (self.t0 or time.monotonic()))), **ev}
            self.events.append(ev)

    def counters(self) -> dict:
        with self.lock:
            el = (time.monotonic() - self.t0) if self.t0 else 0.0
            if self.stage != "deciding" and self.doc.get("_deciding_s"):
                el = self.doc["_deciding_s"]
            return {"total": self.total, "decided": self.decided,
                    "per_second": round(self.decided / el, 1) if el > 0 else 0.0,
                    "p50_ms": int(1000 * statistics.median(self.latencies)) if self.latencies else 0,
                    "decisions_per_conversation": 5}

    def finish(self, intake: dict | None = None, error: tuple[str, str] | None = None) -> None:
        with self.lock:
            if error:
                self.state = "failed"
                self.doc["state"] = "failed"
                self.doc["error"] = {"code": error[0], "message": error[1]}
            else:
                self.state = "completed"
                self.doc["state"] = "completed"
                self.doc["intake"] = intake
            self._save()

    def page(self, after: int = 0, limit: int = 200) -> dict:
        with self.lock:
            evs = [e for e in self.events if e["seq"] > after][:limit]
            state, stage = self.state, self.stage
        out = {"run_id": self.id, "state": state, "stage": stage, "counters": self.counters(), "events": evs}
        if state == "completed":
            out["intake"] = self.doc.get("intake")
        if state == "failed":
            out["error"] = self.doc.get("error")
        return out


def _leaf_question(st: dict) -> tuple[dict, dict[str, str]]:
    """Theme Choice over the snapshot's leaves (+ Other or unclear): option name -> leaf id."""
    from .pipeline.questions import theme_question
    themes, by_name = [], {}
    for lf in st["leaves"]:
        if lf["is_other"]:
            continue
        name = lf["title"]
        while name in by_name:
            name += " (b)"
        by_name[name] = lf["id"]
        themes.append({"name": name, "description": lf.get("description_pub") or lf.get("description") or "",
                       "includes": lf.get("includes") or "", "excludes": lf.get("excludes") or ""})
    return theme_question(themes), by_name


def run_batch(run: IntakeRun, *, evaluate: Callable[[str], None] | None = None) -> dict:
    """Drive one intake run to completion (raises IntakeError on refusal; failures after filing roll back)."""
    from .data import fixtures
    from .pipeline import publish, stats, util
    from .pipeline.gate import _items, deterministic
    from .pipeline.privacy import TokenScanner
    from .pipeline.questions import FRICTION_Q, FRICTION_QV, OTHER_LABEL, SIGNALS
    from .pipeline.run import load_build
    from .providers import jev as jevmod

    from .pipeline import facets as facets_stage
    facets_stage.ensure_schema()
    b = current_batch()
    snap = current_snapshot()
    if (b is None or b["status"] != "ready" or snap is None
            or snap["snapshot_id"] != run.doc["snapshot_id"] or is_intake_snapshot(snap["snapshot_id"])):
        raise IntakeError("intake_not_ready", "no prepared batch for the current snapshot")
    base_snap = snap["snapshot_id"]
    build_id = build_of_snapshot(base_snap)
    build = load_build(build_id)
    st = build.load("structure_final")
    ids = batch_conv_ids(b["batch_id"])
    rows = util.load_rows(ids, "SELECT c.conv_id, c.text, c.language, c.turns, f.user_goal, f.task, f.domain, k.status AS pii "
                               "FROM conversations c LEFT JOIN facets f USING(conv_id) "
                               "LEFT JOIN facet_checks k USING(conv_id) WHERE c.conv_id IN ({})")
    theme_q, by_name = _leaf_question(st)
    questions = {**FRICTION_Q, **theme_q}
    leaf_theme = {lf["id"]: (lf["theme_ids"][0] if lf["theme_ids"] else "other") for lf in st["leaves"]}

    # ---- deciding (live, concurrent; one event per answer as it lands)
    run.set_stage("deciding", "running")
    run.t0 = time.monotonic()
    decisions: dict[str, dict] = {}

    def decide(cid: str) -> tuple[str, dict, float]:
        r = rows[cid]
        state = {"conversation": r["text"],
                 "facets": {"user_goal": r["user_goal"] or "", "task": r["task"] or "", "domain": r["domain"] or ""}}
        last: Exception | None = None
        for attempt in range(2):
            if abort.is_set():
                raise _Aborted()
            t = time.monotonic()
            try:
                ans = ASK(state, questions)
                return cid, ans, time.monotonic() - t
            except ProviderError as e:
                if e.fatal:   # auth / billing: no retry, and stop the whole run
                    abort.set()
                    fatal.append(e)
                    raise
                last = e
            except Exception as e:  # one retry, then give up on this conversation
                last = e
        raise last  # type: ignore[misc]

    from .providers.http import ProviderError
    abort = threading.Event()
    fatal: list = []
    failures = 0
    with ThreadPoolExecutor(max_workers=settings().jev_concurrency) as ex:
        futs = [ex.submit(decide, c) for c in ids]
        for f in as_completed(futs):
            if abort.is_set():
                for other in futs:
                    other.cancel()
            try:
                cid, ans, lat = f.result()
            except Exception as e:
                failures += 1
                if not abort.is_set():
                    log.warning("intake decision failed (%s)", type(e).__name__)
                continue
            choice, p = jevmod.top(ans["theme"])
            leaf = by_name.get(choice) if (choice != OTHER_LABEL and p >= JEV_CONFIDENCE_CUTOFF) else None
            leaf = leaf or OTHER_LEAF
            fr = {}
            raw = {}
            for s_ in SIGNALS:
                stored, rawc, ps = jevmod.tri_state(ans[s_], JEV_CONFIDENCE_CUTOFF)
                fr[s_] = stored
                raw[s_] = (rawc, ps)
            decisions[cid] = {"leaf": leaf, "p": p, "friction": fr, "raw": raw}
            r = rows[cid]
            run.add_event({"leaf_id": leaf, "p": round(float(p), 3), "friction": fr,
                           "language": r["language"] or "Unknown", "turns": int(r["turns"] or 0),
                           "summary": summary_for(r["task"], r["pii"])}, lat)
    run.doc["_deciding_s"] = round(time.monotonic() - run.t0, 3)
    if fatal:   # nothing has been filed or published
        run.set_stage("deciding", "failed", f"Jev unavailable: {fatal[0].code}")
        raise IntakeError("jev_unavailable", f"Jev unavailable: {fatal[0].code}; nothing was filed or published")
    run.set_stage("deciding", "done", f"{len(decisions)} decided, {failures} failed")
    if not decisions:
        raise IntakeError("intake_failed", "no decisions could be made")

    # ---- filing
    run.set_stage("filing", "running")
    con = db.private()
    now = utcnow()
    new_id = None
    try:
        with db.write(con):
            for cid in ids:  # undecided conversations are filed as Other, friction unclear (never guessed)
                d = decisions.get(cid)
                theme = leaf_theme.get(d["leaf"], "other") if d and d["leaf"] != OTHER_LEAF else "other"
                con.execute("INSERT OR REPLACE INTO assignments(build_id, conv_id, theme_id, p, round) VALUES (?,?,?,?,?)",
                            (build_id, cid, theme, float(d["p"]) if d else 0.0, INTAKE_ROUND))
                for s_ in SIGNALS:
                    choice = d["friction"][s_] if d else "unclear"
                    rawc, ps = d["raw"][s_] if d else ("unclear", 0.0)
                    con.execute("INSERT OR REPLACE INTO friction(conv_id, signal, choice, raw_choice, p, model, question_version, created_at)"
                                " VALUES (?,?,?,?,?,?,?,?)", (cid, s_, choice, rawc, float(ps), JEV, FRICTION_QV, now))
        run.set_stage("filing", "done", f"{len(ids)} conversations filed")

        # ---- gating: updated snapshot = base build texts + metrics over base + batch
        run.set_stage("gating", "running")
        clusters = stats.clusters_for(st)
        arows = stats.assignment_rows(build_id, clusters)
        metrics = stats.reference_metrics(arows, clusters)
        langs = stats.languages_by_node(arows, clusters)
        new_id = __import__("logless.ids", fromlist=["snapshot_id"]).snapshot_id()
        scope_build = util.Build(build_id=build.build_id, limit=build.limit, conv_ids=list(build.conv_ids) + ids,
                                 started_at=build.started_at, stages=list(build.stages), info=dict(build.info))
        intake_stage = {"stage": "intake", "started_at": run.doc["created_at"], "finished_at": utcnow(),
                        "counts": {"conversations": len(ids), "decided": len(decisions),
                                   "other": sum(1 for d in decisions.values() if d["leaf"] == OTHER_LEAF) + (len(ids) - len(decisions))},
                        "models": [JEV]}
        stages = list(build.stages) + [intake_stage]
        secs = sum((build.info.get("stage_seconds") or {}).values()) + run.doc["_deciding_s"]
        new_snap = publish.build_snapshot(scope_build, st, {"snapshot_id": new_id, "metrics": metrics, "languages": langs},
                                          stages, secs)
        errs = publish.validate(new_snap, arows, clusters, strict_ranges=build.limit is None)
        scanner = TokenScanner(fixtures.load_tokens())
        sc = publish.scan(new_snap, scanner)
        if sc["fixture_tokens"] or sc["contact"] or sc["source_id"]:
            errs.append("leak scan found a fixture token or contact/source-id pattern")
        corpus = [r["text"] for r in util.load_rows(scope_build.conv_ids,
                                                    "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})").values()]
        items = _items(st) + [{"key": f"{n['id']}|short", "node": n["id"], "role": "short_title", "text": n["short_title"]}
                              for n in st["leaves"] + st["categories"] if n.get("short_title")]
        det = deterministic(items, scanner, corpus)
        flagged = [k for k, v in det.items() if v]
        if flagged:
            errs.append(f"privacy gate: {len(flagged)} published texts fail against the updated corpus")
        errs += publish.api_self_check(new_snap)
        if errs:
            run.set_stage("gating", "failed", f"{len(errs)} checks failed")
            raise IntakeError("intake_gate_failed", "; ".join(errs)[:300])
        run.set_stage("gating", "done", f"{len(items)} texts, invariants and leak scans passed")

        # ---- publishing (atomic flip) + live-question inputs
        run.set_stage("publishing", "running")
        stats.save_cluster_map(new_id, build_id, clusters)
        with db.write(con):
            con.execute("UPDATE intake_batches SET status='ingested', ingested_snapshot_id=?, ingested_at=?, base_snapshot_id=?,"
                        " base_build_id=? WHERE batch_id=?", (new_id, utcnow(), base_snap, build_id, b["batch_id"]))
        publish.publish_snapshot(new_snap)
        run.set_stage("publishing", "done", new_id)
    except Exception:
        # The public flip is the commit point. Never invalidate a snapshot already visible to
        # readers, even if a later progress write fails. Frozen rows are private and harmless
        # before publication; any failed attempt can be retried with a fresh snapshot id.
        current = current_snapshot()
        if new_id is None or not current or current["snapshot_id"] != new_id:
            _clear_decisions(build_id, ids)
            with db.write(con):
                con.execute("UPDATE intake_batches SET status='ready', ingested_snapshot_id=NULL, ingested_at=NULL"
                            " WHERE batch_id=?", (b["batch_id"],))
        raise

    other = sum(1 for d in decisions.values() if d["leaf"] == OTHER_LEAF) + (len(ids) - len(decisions))
    before = {n["id"]: n for n in snap["clusters"]}
    deltas = []
    for n in new_snap["clusters"]:
        o = before.get(n["id"])
        if not o:
            continue
        deltas.append({"id": n["id"], "conversations_before": o["conversations"], "conversations_after": n["conversations"],
                       "friction_share_before": o["friction"]["share"], "friction_share_after": n["friction"]["share"]})
    deltas.sort(key=lambda d: (-abs(d["conversations_after"] - d["conversations_before"]),
                               -abs((d["friction_share_after"] or 0) - (d["friction_share_before"] or 0)), d["id"]))
    intake = {"batch_size": len(ids), "decided": len(decisions), "other": other, "published_snapshot_id": new_id,
              "base_snapshot_id": base_snap, "deltas": deltas[:8]}
    run.finish(intake)

    # ---- evaluating (background)
    run.set_stage("evaluating", "running")

    def _eval() -> None:
        try:
            (evaluate or _default_evaluate)(new_id)
            run.set_stage("evaluating", "done")
        except Exception as e:
            log.warning("intake eval failed (%s)", type(e).__name__)
            run.set_stage("evaluating", "failed", "evaluation report not regenerated")
        with run.lock:
            run.stage = "done"

    threading.Thread(target=_eval, daemon=True).start()
    return intake


def _default_evaluate(snapshot_id: str) -> None:
    from .eval import report
    report.generate(write_summary=False, snapshot_id=snapshot_id)


def _freeze_base_inputs(snapshot_id: str) -> None:
    """A base snapshot published before live-question inputs were frozen has none, so Loggy fails on it
    after a reset. With the batch's decisions cleared, the build's rows are exactly the base's again."""
    from .sandbox.export import has_frozen_inputs, load_cluster_map, save_cluster_map
    found = load_cluster_map(snapshot_id)
    if found is not None and not has_frozen_inputs(snapshot_id):
        save_cluster_map(snapshot_id, *found)


def _clear_decisions(build_id: str | None, ids: list[str]) -> None:
    con = db.private()
    with db.write(con):
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = ",".join("?" * len(chunk))
            if build_id:
                con.execute(f"DELETE FROM assignments WHERE build_id = ? AND conv_id IN ({q})", [build_id, *chunk])
            else:
                con.execute(f"DELETE FROM assignments WHERE round = ? AND conv_id IN ({q})", [INTAKE_ROUND, *chunk])
            con.execute(f"DELETE FROM friction WHERE conv_id IN ({q})", chunk)


# ---------------------------------------------------------------- reset

def reset() -> dict:
    """Re-publish the base snapshot and clear the batch's decisions. Idempotent."""
    ensure_schema()
    b = current_batch()
    if b is None:
        return {"reset": False, "snapshot_id": (current_snapshot() or {}).get("snapshot_id")}
    ids = batch_conv_ids(b["batch_id"])
    base = b.get("base_snapshot_id")
    build_id = b.get("base_build_id") or (build_of_snapshot(base) if base else None)
    restored = False
    cur = current_snapshot()
    allowed = {base, b.get("ingested_snapshot_id")}
    if cur is not None and cur["snapshot_id"] not in allowed:
        raise IntakeError("stale_intake", "A different build is current; reset cannot replace it.")
    if base and snapshot_json(base) is not None and (cur is None or cur["snapshot_id"] != base):
        con = db.public()
        with db.write(con):
            con.execute("UPDATE snapshots SET is_current = 0 WHERE is_current = 1")
            con.execute("UPDATE snapshots SET is_current = 1 WHERE snapshot_id = ?", (base,))
        restored = True
    _clear_decisions(build_id, ids)
    if base:
        _freeze_base_inputs(base)
    con = db.private()
    with db.write(con):
        con.execute("UPDATE intake_batches SET status = 'ready', ingested_snapshot_id = NULL, ingested_at = NULL"
                    " WHERE batch_id = ?", (b["batch_id"],))
    return {"reset": True, "restored_base": restored, "snapshot_id": (current_snapshot() or {}).get("snapshot_id"),
            "batch_size": len(ids)}
