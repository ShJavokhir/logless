"""Stage 5 — stats. Published numbers come from executed code, never from a model.

Preferred path: `logless.sandbox.aggregate.run_aggregate(build_id, clusters, snapshot_id)` runs the
version-controlled aggregation task in the sandbox VM and gates it against a trusted reference.
If the sandbox module is not importable yet or raises `SandboxUnavailable`, the same metrics come
from `reference_metrics` below and provenance records `stats_source: "local-reference"` (the final
build must use the sandbox: re-run with `logless rebuild --from-stage stats`).

`assignment_rows` + `reference_metrics` are the trusted reference; the sandbox gate may reuse them.
Languages are always computed here from private data (the sandbox never sees language)."""
from __future__ import annotations

import logging
from collections import Counter, defaultdict

from .. import db
from ..ids import snapshot_id as new_snapshot_id
from . import util
from .classify import OTHER
from .hierarchy import load_structure
from .questions import FRICTION_QV, SIGNALS

log = logging.getLogger("logless.pipeline.stats")

LANG_MIN_CONV, LANG_MIN_PEOPLE, LANG_TOP = 5, 3, 5
OTHER_LANGUAGES = "Other languages"


def clusters_for(st: dict) -> list[dict]:
    """The `clusters` argument for run_aggregate: leaves and categories with their private theme ids."""
    out = []
    for lf in st["leaves"]:
        out.append({"id": lf["id"], "parent_id": lf["parent_id"], "level": 2, "is_other": bool(lf["is_other"]),
                    "theme_ids": list(lf["theme_ids"])})
    for c in st["categories"]:
        tids = [t for lf in st["leaves"] if lf["parent_id"] == c["id"] for t in lf["theme_ids"]]
        out.append({"id": c["id"], "parent_id": None, "level": 1, "is_other": bool(c.get("is_other")), "theme_ids": tids})
    return out


def assignment_rows(build_id: str, clusters: list[dict]) -> list[dict]:
    """One private row per conversation in the build: conv_id, user_id, language, leaf_id, category_id and
    the four stored friction choices. Leaf/category come from the build's assignments via theme ids."""
    t2leaf = {t: c["id"] for c in clusters if c["level"] == 2 for t in c["theme_ids"]}
    leaf2cat = {c["id"]: c["parent_id"] for c in clusters if c["level"] == 2}
    con = db.private()
    rows = con.execute(
        "SELECT a.conv_id, a.theme_id, c.user_id, c.language FROM assignments a JOIN conversations c USING(conv_id) "
        "WHERE a.build_id = ? ORDER BY a.conv_id", (build_id,)).fetchall()
    fr: dict[str, dict[str, str]] = defaultdict(dict)
    ids = [r["conv_id"] for r in rows]
    for chunk in util.chunks(ids, 900):
        q = "SELECT conv_id, signal, choice FROM friction WHERE question_version = ? AND conv_id IN ({})".format(",".join("?" * len(chunk)))
        for r in con.execute(q, [FRICTION_QV, *chunk]):
            fr[r["conv_id"]][r["signal"]] = r["choice"]
    out = []
    for r in rows:
        leaf = t2leaf.get(r["theme_id"]) or t2leaf.get(OTHER) or "cl_other"
        d = {"conv_id": r["conv_id"], "user_id": r["user_id"], "language": r["language"] or "Unknown",
             "leaf_id": leaf, "category_id": leaf2cat.get(leaf)}
        for s in SIGNALS:
            d[s] = fr[r["conv_id"]].get(s, "unclear")
        out.append(d)
    return out


def metrics_of(rows: list[dict], total: int) -> dict:
    n = len(rows)
    obs = [any(r[s] == "observed" for s in SIGNALS) for r in rows]
    unclear = sum(1 for r, o in zip(rows, obs) if not o and any(r[s] == "unclear" for s in SIGNALS))
    fc = sum(obs)
    return {
        "conversations": n,
        "users": len({r["user_id"] for r in rows}),
        "share": round(n / total, 4) if total else 0.0,
        "friction": {"conversations": fc, "share": round(fc / n, 4) if n else None, "unclear": unclear,
                     "signals": {s: sum(1 for r in rows if r[s] == "observed") for s in SIGNALS}},
    }


def reference_metrics(rows: list[dict], clusters: list[dict]) -> dict[str, dict]:
    """Metrics (without languages) for every node, plus "total". Categories are unions of their leaves'
    conversations; users are recomputed per node, never summed."""
    total = len(rows)
    by_leaf: dict[str, list[dict]] = defaultdict(list)
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_leaf[r["leaf_id"]].append(r)
        if r["category_id"]:
            by_cat[r["category_id"]].append(r)
    out = {"total": metrics_of(rows, total)}
    for c in clusters:
        out[c["id"]] = metrics_of(by_leaf[c["id"]] if c["level"] == 2 else by_cat[c["id"]], total)
    return out


def languages_of(rows: list[dict]) -> list[dict]:
    """Top 5 languages with >= 5 conversations from >= 3 people; everything else folds into
    "Other languages" (listed only when non-empty), so entries sum to the node's conversations."""
    conv = Counter(r["language"] for r in rows)
    people: dict[str, set] = defaultdict(set)
    for r in rows:
        people[r["language"]].add(r["user_id"])
    ok = [l for l, n in conv.items() if n >= LANG_MIN_CONV and len(people[l]) >= LANG_MIN_PEOPLE]
    ok.sort(key=lambda l: (-conv[l], l))
    top = ok[:LANG_TOP]
    out = [{"name": l, "conversations": conv[l]} for l in top]
    rest = sum(n for l, n in conv.items() if l not in top)
    if rest:
        out.append({"name": OTHER_LANGUAGES, "conversations": rest})
    return out


def languages_by_node(rows: list[dict], clusters: list[dict]) -> dict[str, list[dict]]:
    out = {"total": languages_of(rows)}
    for c in clusters:
        key = "leaf_id" if c["level"] == 2 else "category_id"
        out[c["id"]] = languages_of([r for r in rows if r[key] == c["id"]])
    return out


def _sandbox():
    try:
        from ..sandbox import aggregate  # owned by the sandbox/API agent
        return aggregate
    except ImportError:
        return None


def run(build: util.Build) -> dict:
    st = load_structure(build)
    clusters = clusters_for(st)
    snap = new_snapshot_id()
    build.info["snapshot_id"] = snap
    rows = assignment_rows(build.build_id, clusters)
    ref = reference_metrics(rows, clusters)
    source, receipt, verdict = "local-reference", None, None
    sb = _sandbox()
    if sb is not None:
        try:
            res = sb.run_aggregate(build.build_id, [{k: v for k, v in c.items()} for c in clusters], snap)
            metrics = res["metrics"]
            receipt, verdict = res.get("receipt"), res.get("verdict")
            if verdict is not None and not (verdict.get("passed") if isinstance(verdict, dict) else verdict):
                raise RuntimeError("sandbox aggregate failed its gate")
            # defense in depth: the sandbox result must equal the trusted reference exactly
            for c in clusters:
                if metrics.get(c["id"]) != ref[c["id"]]:
                    raise RuntimeError("sandbox aggregate disagrees with the reference")
            metrics = {**ref, **{k: v for k, v in metrics.items() if k in ref}}
            source = "sandbox"
        except Exception as e:
            if type(e).__name__ != "SandboxUnavailable":
                raise
            log.warning("sandbox unavailable; using the local reference for stats")
            metrics = ref
    else:
        log.warning("sandbox aggregate module not importable; using the local reference for stats")
        metrics = ref
    if source != "sandbox" and sb is not None:
        # live analyses on this snapshot rebuild their inputs from the same theme -> leaf map
        # (run_aggregate saves it itself on the sandbox path)
        try:
            from ..sandbox.export import save_cluster_map
            save_cluster_map(snap, build.build_id, clusters)
        except Exception as e:
            log.warning("could not save the cluster map for live analyses (%s)", type(e).__name__)
    langs = languages_by_node(rows, clusters)
    build.info["stats_source"] = source
    build.info["_stage_models"] = ["sandbox:" + str((receipt or {}).get("runtime", "?"))] if source == "sandbox" else ["local-reference"]
    build.save("stats", {"snapshot_id": snap, "source": source, "metrics": metrics, "languages": langs,
                         "receipt": receipt, "verdict": verdict})
    return {"nodes": len(clusters), "conversations": ref["total"]["conversations"], "users": ref["total"]["users"],
            "sandbox": int(source == "sandbox")}
