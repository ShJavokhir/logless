"""Leaf lineage across snapshots.

Leaf ids are seeded on the build, so a rebuild gives every leaf a new id. To keep a theme trackable
over time, each published leaf names the leaf it continues in the previous snapshot (`previous_id`),
matched one-to-one by the cosine of the two leaves' embedding centroids. Centroids are private
(private.db, keyed by snapshot id); only ids are published. A leaf with no match above LINK_MIN is
new (`previous_id` null). Snapshots built with a different embedding model are not linked.
"""
from __future__ import annotations

import json
import logging

import numpy as np

from .. import db
from ..config import EMBEDDING_MODEL, settings
from . import util
from .describe import leaf_centroids, leaf_members

log = logging.getLogger("logless.lineage")

LINK_MIN = 0.9   # centroid cosine below this is a different theme, not the same one drifting
SCHEMA = """CREATE TABLE IF NOT EXISTS leaf_centroids (
  snapshot_id TEXT NOT NULL, leaf_id TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL,
  PRIMARY KEY (snapshot_id, leaf_id))"""


def centroids(build: util.Build, st: dict) -> dict[str, np.ndarray]:
    """The build's leaf centroids, or {} when its embeddings are not on disk (never embeds here)."""
    if not (settings().data_dir / "embeddings" / f"{build.build_id}.npy").exists():
        log.warning("no embeddings for %s; leaves are not linked to the previous snapshot", build.build_id)
        return {}
    return leaf_centroids(build, leaf_members(build, st["leaves"]))


def _con():
    con = db.private()
    con.execute(SCHEMA)
    return con


def save(snapshot_id: str, cents: dict[str, np.ndarray]) -> None:
    con = _con()
    with db.write(con):
        con.executemany("INSERT OR REPLACE INTO leaf_centroids(snapshot_id, leaf_id, model, vec) VALUES (?,?,?,?)",
                        [(snapshot_id, lid, EMBEDDING_MODEL, np.asarray(v, dtype=np.float32).tobytes())
                         for lid, v in cents.items()])


def copy(src_snapshot_id: str, dst_snapshot_id: str) -> None:
    """An intake snapshot keeps its base build's leaves, so it keeps their centroids."""
    con = _con()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO leaf_centroids(snapshot_id, leaf_id, model, vec)"
                    " SELECT ?, leaf_id, model, vec FROM leaf_centroids WHERE snapshot_id = ?",
                    (dst_snapshot_id, src_snapshot_id))


def load(snapshot_id: str) -> dict[str, np.ndarray]:
    rows = _con().execute("SELECT leaf_id, vec FROM leaf_centroids WHERE snapshot_id = ? AND model = ?",
                          (snapshot_id, EMBEDDING_MODEL)).fetchall()
    return {r["leaf_id"]: np.frombuffer(r["vec"], dtype=np.float32) for r in rows}


def match(new: dict[str, np.ndarray], prev: dict[str, np.ndarray]) -> dict[str, str]:
    """Greedy one-to-one matching, most similar pair first. cl_other always continues cl_other."""
    pairs = sorted(((float(v @ w), a, b) for a, v in new.items() if a != "cl_other"
                    for b, w in prev.items() if b != "cl_other"), reverse=True)
    out, used = {"cl_other": "cl_other"}, set()
    for s, a, b in pairs:
        if s < LINK_MIN:
            break
        if a not in out and b not in used:
            out[a] = b
            used.add(b)
    return out


def link(snap: dict, cents: dict[str, np.ndarray], previous: dict | None) -> None:
    """Set `previous_snapshot_id` and every leaf's `previous_id` in place (null when not linkable)."""
    prev = load(previous["snapshot_id"]) if previous else {}
    m = match(cents, prev) if cents and prev else {}
    snap["previous_snapshot_id"] = previous["snapshot_id"] if m else None
    for leaf in snap["clusters"]:
        leaf["previous_id"] = m.get(leaf["id"])


def carry(snap: dict, base: dict) -> None:
    """An intake snapshot continues its base snapshot leaf for leaf, under the same ids."""
    ids = {leaf["id"] for leaf in base["clusters"]}
    snap["previous_snapshot_id"] = base["snapshot_id"]
    for leaf in snap["clusters"]:
        leaf["previous_id"] = leaf["id"] if leaf["id"] in ids else None


def current() -> dict | None:
    row = db.public().execute("SELECT json FROM snapshots WHERE is_current = 1 ORDER BY created_at DESC LIMIT 1").fetchone()
    return json.loads(row["json"]) if row else None
