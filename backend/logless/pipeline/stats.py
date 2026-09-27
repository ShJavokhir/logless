"""Stage 5 — stats. Published map numbers come from executed code, never from a model: they are
computed here by the pipeline's own trusted code on the app VM (`assignment_rows` + `reference_metrics`).
The sandbox runs only untrusted, agent-written code (live question programs, containment fixtures), so
aggregation does not run there (docs/CONTRACTS.md §0). Languages per node are computed here as well.
The stage also records the snapshot's private theme -> leaf map, which live question runs load by
snapshot id to rebuild their typed inputs."""
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


def save_cluster_map(snapshot_id: str, build_id: str, clusters: list[dict]) -> None:
    """Private theme -> leaf map for live question runs (stored by the sandbox/API module's helper)."""
    try:
        from ..sandbox.export import save_cluster_map as _save
    except ImportError:
        log.warning("sandbox export module not importable; live questions will not find this snapshot's inputs")
        return
    _save(snapshot_id, build_id, clusters)


def run(build: util.Build) -> dict:
    st = load_structure(build)
    clusters = clusters_for(st)
    snap = new_snapshot_id()
    build.info["snapshot_id"] = snap
    build.info.pop("stats_source", None)
    rows = assignment_rows(build.build_id, clusters)
    metrics = reference_metrics(rows, clusters)
    langs = languages_by_node(rows, clusters)
    save_cluster_map(snap, build.build_id, clusters)
    build.info["_stage_models"] = ["pipeline code (app VM)"]
    build.save("stats", {"snapshot_id": snap, "metrics": metrics, "languages": langs})
    return {"nodes": len(clusters), "conversations": metrics["total"]["conversations"],
            "users": metrics["total"]["users"]}
