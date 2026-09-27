"""Stage 9 — publish atomically. The Snapshot is built field by field from an allowlist
(docs/CONTRACTS.md §5), validated (invariants, key allowlist, fixture-token / contact / source-id
scans on the serialized payload) and only then inserted into public.db with `is_current` flipped in
one transaction. On any failure nothing is written and the previous snapshot stays live."""
from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter

from .. import db
from ..config import (DATASET_REVISION, DATASET_URL, EMBEDDING_MODEL, GLM, GLM_FLASH, JEV)
from ..config_workspace import (INTENDED_USES, SAMPLE_NOTE, SHARD_ROWS, WORKSPACE_DESCRIPTION, WORKSPACE_NAME)
from ..data import fixtures
from ..ids import utcnow
from . import util
from .privacy import TokenScanner, contact_hits, source_id_hits, text_strings
from .prompts import PROMPT_VERSIONS
from .questions import QUESTION_VERSIONS, SIGNALS
from .stats import assignment_rows, clusters_for, reference_metrics

log = logging.getLogger("logless.pipeline.publish")

ATTRIBUTION = 'Zhao et al., "WildChat: 1M ChatGPT Interaction Logs in the Wild", ICLR 2024'
CATS_RANGE, LEAVES_RANGE = (4, 8), (15, 35)


class PublishError(RuntimeError):
    pass


# ---------------------------------------------------------------- builder

def scope_hash(conv_ids: list[str]) -> str:
    """Same construction as data.wildchat.dataset_hash(), restricted to the build's conversations."""
    h = hashlib.sha256(DATASET_REVISION.encode())
    rows = util.load_rows(conv_ids, "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})")
    for cid in sorted(rows):
        h.update(cid.encode())
        h.update(hashlib.sha256(rows[cid]["text"].encode()).digest())
    return h.hexdigest()[:16]


def _metrics(m: dict, langs: list[dict]) -> dict:
    f = m["friction"]
    return {"conversations": int(m["conversations"]), "users": int(m["users"]), "share": round(float(m["share"]), 4),
            "friction": {"conversations": int(f["conversations"]),
                         "share": None if f["share"] is None else round(float(f["share"]), 4),
                         "unclear": int(f["unclear"]),
                         "signals": {s: int(f["signals"][s]) for s in SIGNALS}},
            "languages": [{"name": str(l["name"]), "conversations": int(l["conversations"])} for l in langs]}


def build_snapshot(build: util.Build, st: dict, stats: dict, stages: list[dict], build_seconds: float) -> dict:
    metrics, langs = stats["metrics"], stats["languages"]
    cats_sorted = sorted(st["categories"], key=lambda c: (bool(c.get("is_other")), -metrics[c["id"]]["conversations"], c["id"]))
    leaves_sorted = sorted(st["leaves"], key=lambda l: (bool(l["is_other"]), -metrics[l["id"]]["conversations"], l["id"]))
    categories = []
    for c in cats_sorted:
        node = {"id": c["id"], "level": 1, "parent_id": None, "title": c["title_pub"], "short_title": c["short_title"],
                "description": c["description_pub"],
                **_metrics(metrics[c["id"]], langs[c["id"]]),
                "children": [l["id"] for l in leaves_sorted if l["parent_id"] == c["id"]]}
        if c.get("is_other"):
            node["is_other"] = True
        categories.append(node)
    clusters = []
    for l in leaves_sorted:
        node = {"id": l["id"], "level": 2, "parent_id": l["parent_id"], "title": l["title"], "short_title": l["short_title"],
                "description": l["description_pub"],
                **_metrics(metrics[l["id"]], langs[l["id"]]),
                "needs": [{"id": n["id"], "text": n["text"]} for n in l.get("needs", [])],
                "problems": [{"id": p["id"], "text": p["text"], "signal": p["signal"], "support": p["support"]}
                             for p in l.get("problems", [])]}
        if l.get("surprising") and not l["is_other"]:
            node["surprising"] = {"flag": bool(l["surprising"]["flag"]), "score": round(float(l["surprising"]["score"]), 4)}
        if l["is_other"]:
            node["is_other"] = True
        clusters.append(node)
    con = db.private()
    scope_rows = util.load_rows(build.conv_ids, "SELECT conv_id, ts, is_fixture, language, user_id FROM conversations WHERE conv_id IN ({})")
    real_ts = sorted(r["ts"][:10] for r in scope_rows.values() if not r["is_fixture"] and r["ts"])
    kinds = Counter(r["kind"] for r in con.execute(
        "SELECT kind FROM eval_fixtures WHERE conv_id IN (SELECT conv_id FROM conversations WHERE is_fixture = 1)"))
    n_real = sum(1 for r in scope_rows.values() if not r["is_fixture"])
    fac_models = {r["model"] for r in con.execute("SELECT DISTINCT model FROM facets WHERE model IS NOT NULL")}
    facets_model = GLM_FLASH if fac_models <= {GLM_FLASH} else f"{GLM_FLASH} (rate-limit overflow: {GLM})"
    # roles the UI lists; analysis_code / explanation / story / relevance are the API's live features
    models = {"facets": facets_model, "friction": JEV, "embeddings": EMBEDDING_MODEL, "naming": GLM,
              "consolidation": GLM, "classification": JEV, "hierarchy": GLM, "descriptions": GLM,
              "privacy_audit": GLM, "identifiability": JEV, "surprising": JEV,
              "analysis_code": GLM, "explanation": GLM, "story": GLM, "relevance": JEV}
    snap = {
        "snapshot_id": stats["snapshot_id"],
        "created_at": utcnow(),
        "workspace": {"name": WORKSPACE_NAME, "description": WORKSPACE_DESCRIPTION},
        "dataset": {
            "name": "WildChat-1M", "source_url": DATASET_URL, "revision": DATASET_REVISION, "license": "ODC-BY-1.0",
            "attribution": ATTRIBUTION,
            "period_start": real_ts[0] if real_ts else "", "period_end": real_ts[-1] if real_ts else "",
            "conversations": len(scope_rows), "users": len({r["user_id"] for r in scope_rows.values()}),
            "languages": len({r["language"] for r in scope_rows.values() if r["language"]}),
            "sample_note": SAMPLE_NOTE.format(real=n_real, shard_rows=SHARD_ROWS, canary=kinds.get("canary", 0),
                                              injection=kinds.get("injection", 0)),
            "fixtures": {"canary_conversations": int(kinds.get("canary", 0)),
                         "injection_conversations": int(kinds.get("injection", 0))},
        },
        "totals": _metrics(metrics["total"], langs["total"]),
        "categories": categories,
        "clusters": clusters,
        "intended_uses": list(INTENDED_USES),
        "provenance": {
            "pipeline_version": _pipeline_version(),
            "dataset_hash": scope_hash(build.conv_ids),
            "models": models,
            "prompt_versions": {**PROMPT_VERSIONS, **QUESTION_VERSIONS},
            "discovery_rounds": int(build.info.get("discovery_rounds", 1)),
            "build_seconds": int(round(build_seconds)),
            "stats_source": stats["source"],
            "stages": [{"stage": s["stage"], "started_at": s["started_at"], "finished_at": s["finished_at"],
                        "counts": public_counts(s["counts"]), "models": [str(m) for m in s["models"]]}
                       for s in stages],
        },
    }
    return snap


COUNT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def public_counts(counts: dict) -> dict[str, int]:
    """Stage counts as published: non-negative integer counts only. Ratios and diagnostics (older build
    records carried *_x1000 / *_x10000 values) stay in the private build record."""
    out = {}
    for k, v in counts.items():
        if not COUNT_KEY.match(str(k)) or re.search(r"_x10+$", str(k)):
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != int(v):
            continue
        out[str(k)] = int(v)
    return out


def _pipeline_version() -> str:
    from .run import PIPELINE_VERSION
    return PIPELINE_VERSION


# ---------------------------------------------------------------- validation

K_SNAP = {"snapshot_id", "created_at", "workspace", "dataset", "totals", "categories", "clusters", "intended_uses", "provenance"}
K_WS = {"name", "description"}
K_DS = {"name", "source_url", "revision", "license", "attribution", "period_start", "period_end", "conversations", "users",
        "languages", "sample_note", "fixtures"}
K_FIX = {"canary_conversations", "injection_conversations"}
K_MET = {"conversations", "users", "share", "friction", "languages"}
K_FR = {"conversations", "share", "unclear", "signals"}
K_LANG = {"name", "conversations"}
K_NODE = K_MET | {"id", "level", "parent_id", "title", "short_title", "description", "children", "needs", "problems", "surprising", "is_other"}
K_NEED = {"id", "text"}
K_PROB = {"id", "text", "signal", "support"}
K_SUR = {"flag", "score"}
K_PROV = {"pipeline_version", "dataset_hash", "models", "prompt_versions", "discovery_rounds", "build_seconds", "stats_source", "stages"}
K_STAGE = {"stage", "started_at", "finished_at", "counts", "models"}


def _keys(obj: dict, allowed: set[str], where: str, errs: list[str]) -> None:
    extra = set(obj) - allowed
    if extra:
        errs.append(f"{where}: unexpected keys {sorted(extra)}")


def _check_metrics(m: dict, where: str, errs: list[str]) -> None:
    _keys(m, K_MET | K_NODE, where, errs)
    _keys(m["friction"], K_FR, where + ".friction", errs)
    _keys(m["friction"]["signals"], set(SIGNALS), where + ".friction.signals", errs)
    for l in m["languages"]:
        _keys(l, K_LANG, where + ".languages", errs)
    if sum(l["conversations"] for l in m["languages"]) != m["conversations"]:
        errs.append(f"{where}: languages do not sum to conversations")
    if len([l for l in m["languages"] if l["name"] != "Other languages"]) > 5:
        errs.append(f"{where}: more than 5 languages listed")


def validate(snap: dict, rows: list[dict] | None = None, clusters_arg: list[dict] | None = None, *, strict_ranges: bool = True) -> list[str]:
    """Invariants + allowlist. Returns a list of errors (empty = valid)."""
    errs: list[str] = []
    _keys(snap, K_SNAP, "snapshot", errs)
    _keys(snap["workspace"], K_WS, "workspace", errs)
    _keys(snap["dataset"], K_DS, "dataset", errs)
    _keys(snap["dataset"]["fixtures"], K_FIX, "dataset.fixtures", errs)
    _keys(snap["provenance"], K_PROV, "provenance", errs)
    for s in snap["provenance"]["stages"]:
        _keys(s, K_STAGE, "provenance.stages", errs)
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in s["counts"].values()):
            errs.append("provenance.stages: counts must be non-negative integers")
    for k in ("models", "prompt_versions"):
        if not all(isinstance(v, str) for v in snap["provenance"][k].values()):
            errs.append(f"provenance.{k}: non-string value")
    _check_metrics(snap["totals"], "totals", errs)
    cats, leaves = snap["categories"], snap["clusters"]
    ids = [n["id"] for n in cats + leaves]
    if len(ids) != len(set(ids)):
        errs.append("node ids are not unique")
    shorts = [str(n.get("short_title", "")).casefold() for n in cats + leaves]
    if len(shorts) != len(set(shorts)):
        errs.append("short_title values are not unique")
    if not all(n["id"].startswith("cat_") and n["level"] == 1 and n["parent_id"] is None for n in cats):
        errs.append("category id/level/parent malformed")
    if not all(n["id"].startswith("cl_") and n["level"] == 2 for n in leaves):
        errs.append("leaf id/level malformed")
    if sum(1 for n in leaves if n["id"] == "cl_other") != 1:
        errs.append("exactly one cl_other leaf required")
    cat_ids = {c["id"] for c in cats}
    for n in cats + leaves:
        _check_metrics(n, n["id"], errs)
        _keys(n, K_NODE, n["id"], errs)
        if len(n["title"].split()) > 8:
            errs.append(f"{n['id']}: title longer than 8 words")
        st_ = n.get("short_title")
        if not isinstance(st_, str) or not st_.strip() or len(st_) > 22 or len(st_.split()) > 3:
            errs.append(f"{n['id']}: short_title missing or not 1-3 words / <= 22 characters")
    for l in leaves:
        if l["parent_id"] not in cat_ids:
            errs.append(f"{l['id']}: parent missing")
        for x in l.get("needs", []):
            _keys(x, K_NEED, l["id"] + ".needs", errs)
        for x in l.get("problems", []):
            _keys(x, K_PROB, l["id"] + ".problems", errs)
            if x["signal"] not in (*SIGNALS, None) or x["support"] not in ("observed", "common"):
                errs.append(f"{l['id']}: bad problem signal/support")
        ev = [x["id"] for x in l.get("needs", []) + l.get("problems", [])]
        if len(ev) != len(set(ev)):
            errs.append(f"{l['id']}: evidence ids not unique")
        if "surprising" in l:
            _keys(l["surprising"], K_SUR, l["id"] + ".surprising", errs)
    for c in cats:
        kids = [l["id"] for l in leaves if l["parent_id"] == c["id"]]
        if sorted(kids) != sorted(c.get("children", [])):
            errs.append(f"{c['id']}: children do not match leaf parents")
        if not kids:
            errs.append(f"{c['id']}: empty category")
        if c["conversations"] != sum(l["conversations"] for l in leaves if l["parent_id"] == c["id"]):
            errs.append(f"{c['id']}: conversations are not the union of its leaves")
    total = snap["totals"]["conversations"]
    if sum(l["conversations"] for l in leaves) != total:
        errs.append("leaf conversations do not sum to the total")
    if total != snap["dataset"]["conversations"]:
        errs.append("totals and dataset conversations differ")
    for n in cats + leaves + [snap["totals"]]:
        exp = round(n["conversations"] / total, 4) if total else 0.0
        if abs(n["share"] - exp) > 1e-9:
            errs.append(f"{n.get('id', 'totals')}: share not recomputed")
    if strict_ranges:
        if not (CATS_RANGE[0] <= len(cats) <= CATS_RANGE[1]):
            errs.append(f"{len(cats)} categories outside {CATS_RANGE}")
        if not (LEAVES_RANGE[0] <= len(leaves) <= LEAVES_RANGE[1]):
            errs.append(f"{len(leaves)} leaves outside {LEAVES_RANGE}")
    if rows is not None and clusters_arg is not None:
        ref = reference_metrics(rows, clusters_arg)
        for n in cats + leaves:
            r = ref[n["id"]]
            if (n["conversations"], n["users"], n["friction"]["conversations"], n["friction"]["unclear"],
                    n["friction"]["signals"]) != (r["conversations"], r["users"], r["friction"]["conversations"],
                                                  r["friction"]["unclear"], r["friction"]["signals"]):
                errs.append(f"{n['id']}: metrics differ from the reference recomputation")
        if snap["totals"]["users"] != ref["total"]["users"]:
            errs.append("total users differ from the reference")
    return errs


def scan(snap: dict, scanner: TokenScanner) -> dict[str, int]:
    """Fixture tokens over the whole serialized payload; contact / source-id patterns over text fields."""
    payload = json.dumps(snap, ensure_ascii=False)
    out = {"fixture_tokens": scanner.hits(payload), "contact": 0, "source_id": 0}
    for path, s in text_strings(snap):
        if path.startswith("workspace.") or path.startswith("dataset."):
            continue  # fixed, operator-authored metadata
        out["contact"] += len(contact_hits(s))
        out["source_id"] += len(source_id_hits(s))
    return out


# ---------------------------------------------------------------- stage

def api_self_check(snap: dict) -> list[str]:
    """Run the API's own allowlist serializer on the snapshot before it goes live, so a snapshot the API
    would refuse to serve (`Blocked`) is never published."""
    try:
        from ..api.serializers import Blocked, serialize_snapshot
    except ImportError:
        log.warning("API serializer not importable; skipping the publish-time self-check")
        return []
    try:
        serialize_snapshot(json.loads(json.dumps(snap, ensure_ascii=False)))
    except Blocked as e:
        return [f"API serializer blocked the snapshot: {e}"]
    except Exception as e:
        return [f"API serializer failed on the snapshot: {type(e).__name__}"]
    return []


def publish_snapshot(snap: dict) -> None:
    con = db.public()
    with db.write(con):
        con.execute("UPDATE snapshots SET is_current = 0 WHERE is_current = 1")
        con.execute("INSERT INTO snapshots(snapshot_id, created_at, json, is_current) VALUES (?,?,?,1)",
                    (snap["snapshot_id"], snap["created_at"], json.dumps(snap, ensure_ascii=False)))


def run(build: util.Build) -> dict:
    st = build.load("structure_final")
    stats = build.load("stats")
    if stats["snapshot_id"] != build.info.get("snapshot_id"):
        raise PublishError("stats were computed for a different snapshot id; re-run the stats stage")
    started = utcnow()
    stages = list(build.stages) + [{"stage": "publish", "started_at": started, "finished_at": started,
                                    "counts": {}, "models": []}]
    secs = sum(build.info.get("stage_seconds", {}).values())
    snap = build_snapshot(build, st, stats, stages, secs)
    clusters = clusters_for(st)
    rows = assignment_rows(build.build_id, clusters)
    errs = validate(snap, rows, clusters, strict_ranges=build.limit is None)
    if build.limit is not None:
        # pilot builds may be small; still report range issues without blocking
        for e in validate(snap, strict_ranges=True):
            if "outside" in e:
                log.warning("pilot build: %s", e)
    sc = scan(snap, TokenScanner(fixtures.load_tokens()))
    if sc["fixture_tokens"]:
        errs.append("fixture token detected in the payload")
    if sc["contact"] or sc["source_id"]:
        errs.append("contact or source-id pattern detected in published text")
    errs += api_self_check(snap)
    if errs:
        build.save("publish_errors", errs)
        raise PublishError(f"snapshot failed validation ({len(errs)} errors); previous snapshot stays live")
    publish_snapshot(snap)
    build.save("snapshot", snap)
    build.info["snapshot_id"] = snap["snapshot_id"]
    try:
        from ..eval.summary import write_summary
        write_summary(snap, build)
    except Exception as e:  # the summary is a convenience; never block a publish
        log.warning("summary not written (%s)", type(e).__name__)
    return {"categories": len(snap["categories"]), "leaves": len(snap["clusters"]),
            "conversations": snap["totals"]["conversations"], "fixture_token_hits": sc["fixture_tokens"],
            "pattern_hits": sc["contact"] + sc["source_id"]}
