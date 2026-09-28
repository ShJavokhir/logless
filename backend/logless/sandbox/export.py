"""Build the typed, text-free sandbox inputs of docs/CONTRACTS.md §7 for one build.

The sandbox gets exactly: per-job integer pseudonyms (`row`, `user`) drawn from a fresh random
permutation, the public leaf/category/sub-theme ids, and the four tri-state friction decisions. No
conversation or user ids, no language, turn counts, timestamps or text."""
from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import db
from ..ids import utcnow

log = logging.getLogger("logless.sandbox.export")

SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")
COLUMNS = ["row", "user", "leaf_id", "category_id", "subtheme_id", *SIGNALS]
CHOICES = {"observed", "not_observed", "unclear"}

# One statement, run with con.execute(): a multi-statement script call would first COMMIT any
# transaction the caller (e.g. the pipeline) has open on this thread's connection.
CLUSTER_MAP_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS sandbox_cluster_map ("
    " snapshot_id TEXT PRIMARY KEY,"
    " build_id TEXT NOT NULL,"
    " clusters_json TEXT NOT NULL,"   # [{id, parent_id, level, is_other, theme_ids}]
    " created_at TEXT NOT NULL)"
)


# The typed rows exactly as they were when a snapshot was published (theme, pseudonym and the four
# friction decisions per conversation), so live questions answer over the same data the published
# numbers came from, even if the pipeline later re-labels friction or rebuilds.
FROZEN_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS sandbox_inputs ("
    " snapshot_id TEXT NOT NULL, conv_id TEXT NOT NULL, user_id TEXT NOT NULL, theme_id TEXT NOT NULL,"
    " correction TEXT NOT NULL, repeat_request TEXT NOT NULL, assistant_limit TEXT NOT NULL, complaint TEXT NOT NULL,"
    " PRIMARY KEY (snapshot_id, conv_id))"
)


class ExportError(RuntimeError):
    pass


@dataclass
class SandboxInputs:
    assignments_csv: str
    clusters_json: str
    df: pd.DataFrame                     # exactly the rows written to assignments.csv
    mapping: dict = field(repr=False)   # private: per-job ints -> c_/u_ ids. Never persisted or sent.
    clusters: list[dict] = field(default_factory=list)  # public structure (no theme ids)
    leaf_ids: list[str] = field(default_factory=list)
    category_ids: list[str] = field(default_factory=list)
    subtheme_ids: list[str] = field(default_factory=list)

    @property
    def other_ids(self) -> frozenset[str]:
        """The catch-all leaf (is_other), which the ordering rule always puts last."""
        return frozenset(c["id"] for c in self.clusters if int(c["level"]) == 2 and c.get("is_other")) | \
            (frozenset({"cl_other"}) & frozenset(self.leaf_ids))

    def files(self, contract: dict) -> dict[str, str]:
        return {"assignments.csv": self.assignments_csv, "clusters.json": self.clusters_json,
                "contract.json": json.dumps(contract, indent=1)}


def public_structure(clusters: list[dict]) -> list[dict]:
    """[{id, parent_id, level, is_other}] sorted by level then id — what clusters.json holds."""
    out = [{"id": str(c["id"]), "parent_id": c.get("parent_id"), "level": int(c["level"]), "is_other": bool(c.get("is_other", False))}
           for c in clusters]
    return sorted(out, key=lambda c: (c["level"], c["id"]))


def _validate_structure(clusters: list[dict]) -> tuple[list[dict], list[dict]]:
    if any(c.get("level") not in (1, 2) for c in clusters):
        raise ExportError("unknown cluster level")
    cats = [c for c in clusters if int(c["level"]) == 1]
    leaves = [c for c in clusters if int(c["level"]) == 2]
    cat_ids = {c["id"] for c in cats}
    if not leaves:
        raise ExportError("no leaf clusters")
    for leaf in leaves:
        if leaf.get("parent_id") not in cat_ids:
            raise ExportError("leaf without a valid parent category")
    if len({c["id"] for c in clusters}) != len(clusters):
        raise ExportError("duplicate cluster ids")
    if any(c.get("parent_id") is not None for c in cats):
        raise ExportError("category cannot have a parent")
    if sum(bool(c.get("is_other")) for c in leaves) > 1:
        raise ExportError("multiple catch-all leaves")
    themes = set()
    for leaf in leaves:
        for theme in leaf.get("theme_ids") or []:
            key = str(theme)
            if key in themes:
                raise ExportError("theme belongs to more than one leaf or is repeated")
            themes.add(key)
    return cats, leaves


def subtheme_nodes(leaves: list[dict], doc: dict | None) -> list[dict]:
    """Level-3 structure from a stored sub-themes document: one node per sub-theme of a published
    leaf, parent_id = the leaf, is_other = the leaf's untitled remainder (`_rest`)."""
    leaf_ids = {c["id"] for c in leaves}
    return [{"id": str(x["id"]), "parent_id": lid, "level": 3, "is_other": bool(x.get("rest"))}
            for lid, items in ((doc or {}).get("leaves") or {}).items() if lid in leaf_ids
            for x in items or [] if str(x["id"]).startswith(lid + "_")]


def frame_from_rows(rows: pd.DataFrame, clusters: list[dict], rng: np.random.Generator | None = None,
                    subtheme_of: dict[str, str] | None = None, subthemes: list[dict] | None = None
                    ) -> tuple[pd.DataFrame, dict]:
    """rows: columns conv_id, user_id, theme_id, plus SIGNALS. `subtheme_of` maps conv ids to ids in
    `subthemes` (level-3 nodes); a conversation keeps its sub-theme only if that sub-theme belongs to
    the conversation's leaf, else (and when it has none) subtheme_id is empty. Returns (sandbox df,
    private mapping)."""
    _, leaves = _validate_structure(clusters)
    theme_to_leaf: dict[str, str] = {}
    for leaf in leaves:
        for t in leaf.get("theme_ids") or []:
            theme_to_leaf[str(t)] = leaf["id"]
    other = next((leaf["id"] for leaf in leaves if leaf.get("is_other")), None)
    parent = {leaf["id"]: leaf["parent_id"] for leaf in leaves}

    leaf_col = rows["theme_id"].astype(str).map(theme_to_leaf)
    if leaf_col.isna().any():
        if other is None:
            raise ExportError("assignments reference themes that map to no leaf and there is no catch-all leaf")
        leaf_col = leaf_col.fillna(other)

    rng = rng or np.random.default_rng(secrets.randbits(64))
    n = len(rows)
    row_ids = rng.permutation(n) + 1
    users = pd.unique(rows["user_id"])
    user_ints = dict(zip(users, (rng.permutation(len(users)) + 1).tolist()))

    sub_parent = {c["id"]: c["parent_id"] for c in subthemes or []}
    sub_col = rows["conv_id"].map(subtheme_of or {})
    sub_col = sub_col.where(sub_col.map(sub_parent) == leaf_col, "").fillna("")
    df = pd.DataFrame({
        "row": row_ids.astype(int),
        "user": rows["user_id"].map(user_ints).astype(int).to_numpy(),
        "leaf_id": leaf_col.to_numpy(),
        "category_id": leaf_col.map(parent).to_numpy(),
        "subtheme_id": sub_col.to_numpy(),
    })
    for s in SIGNALS:
        col = rows[s] if s in rows.columns else pd.Series(["unclear"] * n, index=rows.index)
        col = col.where(col.isin(CHOICES), "unclear").fillna("unclear")
        df[s] = col.to_numpy()
    mapping = {"row": dict(zip(df["row"].tolist(), rows["conv_id"].tolist())),
               "user": {v: k for k, v in user_ints.items()}}
    df = df.sort_values("row", kind="stable").reset_index(drop=True)
    return df[COLUMNS], mapping


def _load_rows(build_id: str) -> pd.DataFrame:
    con = db.private()
    a = pd.read_sql_query(
        "SELECT a.conv_id AS conv_id, a.theme_id AS theme_id, c.user_id AS user_id "
        "FROM assignments a JOIN conversations c ON c.conv_id = a.conv_id WHERE a.build_id = ? ORDER BY a.conv_id",
        con, params=(build_id,))
    if a.empty:
        raise ExportError("no assignments for this build")
    try:  # use exactly the decisions the pipeline's own reference uses (current question version)
        from ..pipeline.questions import FRICTION_QV
        f = pd.read_sql_query("SELECT conv_id, signal, choice FROM friction WHERE question_version = ?", con, params=(FRICTION_QV,))
    except ImportError:
        f = pd.read_sql_query("SELECT conv_id, signal, choice FROM friction", con)
    if not f.empty:
        f = f[f["signal"].isin(SIGNALS) & f["conv_id"].isin(a["conv_id"])]
        wide = f.pivot_table(index="conv_id", columns="signal", values="choice", aggfunc="first")
        a = a.merge(wide, how="left", left_on="conv_id", right_index=True)
    for s in SIGNALS:
        if s not in a.columns:
            a[s] = "unclear"
        a[s] = a[s].fillna("unclear")
    return a


def _load_frozen(snapshot_id: str) -> pd.DataFrame | None:
    con = db.private()
    con.execute(FROZEN_SCHEMA)
    f = pd.read_sql_query("SELECT conv_id, user_id, theme_id, correction, repeat_request, assistant_limit, complaint "
                          "FROM sandbox_inputs WHERE snapshot_id = ? ORDER BY conv_id", con, params=(snapshot_id,))
    return None if f.empty else f


def _load_subthemes(build_id: str, leaves: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """The build's sub-theme nodes and private conv -> sub-theme map, or nothing when the build has no
    sub-themes or they were stored before membership was kept (`logless subthemes --members-only`)."""
    from ..pipeline.subthemes import load_for_build, load_members
    doc = load_for_build(build_id)
    members = load_members(build_id) if doc else {}
    if not members:
        if doc:
            log.warning("sub-themes of build %s have no stored membership; questions cannot group by them", build_id)
        return [], {}
    return subtheme_nodes(leaves, doc), members


def export_inputs(build_id: str, clusters: list[dict], snapshot_id: str | None = None) -> SandboxInputs:
    """Typed inputs for one sandbox job. `clusters`: [{id, parent_id, level, is_other, theme_ids}].
    With `snapshot_id`, only the rows frozen when that snapshot was published may be used.
    Historical snapshots without frozen inputs must be rebuilt before live analysis is available.
    The build's sub-themes (if any) are added as level-3 nodes; rows the sub-themes don't cover
    (e.g. conversations added by a later intake batch) get an empty subtheme_id."""
    cats, leaves = _validate_structure(clusters)
    rows = _load_frozen(snapshot_id) if snapshot_id else None
    if snapshot_id and rows is None:
        raise ExportError("snapshot has no frozen sandbox inputs")
    if rows is None:
        rows = _load_rows(build_id)
    subs, members = _load_subthemes(build_id, leaves)
    df, mapping = frame_from_rows(rows, clusters, subtheme_of=members, subthemes=subs)
    structure = public_structure(clusters + subs)
    return SandboxInputs(
        assignments_csv=df.to_csv(index=False, lineterminator="\n"),
        clusters_json=json.dumps(structure),
        df=df, mapping=mapping, clusters=structure,
        leaf_ids=sorted(c["id"] for c in leaves), category_ids=sorted(c["id"] for c in cats),
        subtheme_ids=sorted(c["id"] for c in subs),
    )


# ---------------------------------------------------------------- cluster map persistence

def save_cluster_map(snapshot_id: str, build_id: str, clusters: list[dict]) -> None:
    """Remember which private themes make up each published leaf AND freeze the typed rows (theme,
    pseudonym, friction decisions) as they are now, so live questions on `snapshot_id` answer over
    exactly the data its published numbers came from. Private (private.db) only. Call it when the
    snapshot's metrics are computed (the pipeline's stats stage does)."""
    _validate_structure(clusters)
    con = db.private()
    con.execute(CLUSTER_MAP_SCHEMA)
    slim = [{"id": c["id"], "parent_id": c.get("parent_id"), "level": int(c["level"]), "is_other": bool(c.get("is_other", False)),
             "theme_ids": [str(t) for t in (c.get("theme_ids") or [])]} for c in clusters]
    rows = _load_rows(build_id)   # the typed rows as of publication, frozen below
    con.execute(FROZEN_SCHEMA)
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO sandbox_cluster_map(snapshot_id, build_id, clusters_json, created_at) VALUES (?,?,?,?)",
                    (snapshot_id, build_id, json.dumps(slim), utcnow()))
        con.execute("DELETE FROM sandbox_inputs WHERE snapshot_id = ?", (snapshot_id,))
        con.executemany(
            "INSERT INTO sandbox_inputs(snapshot_id, conv_id, user_id, theme_id, correction, repeat_request, assistant_limit, complaint) "
            "VALUES (?,?,?,?,?,?,?,?)",
            [(snapshot_id, r.conv_id, r.user_id, str(r.theme_id), r.correction, r.repeat_request, r.assistant_limit, r.complaint)
             for r in rows.itertuples(index=False)])


def has_frozen_inputs(snapshot_id: str) -> bool:
    con = db.private()
    con.execute(FROZEN_SCHEMA)
    return con.execute("SELECT 1 FROM sandbox_inputs WHERE snapshot_id=? LIMIT 1", (snapshot_id,)).fetchone() is not None


def load_cluster_map(snapshot_id: str) -> tuple[str, list[dict]] | None:
    con = db.private()
    con.execute(CLUSTER_MAP_SCHEMA)
    row = con.execute("SELECT build_id, clusters_json FROM sandbox_cluster_map WHERE snapshot_id=?", (snapshot_id,)).fetchone()
    if row is None:
        return None
    return row["build_id"], json.loads(row["clusters_json"])
