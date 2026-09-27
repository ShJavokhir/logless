"""Shared helpers for the sandbox / API tests (kept out of conftest.py so other test suites in
this directory can own that file)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from logless import db
from logless.config import settings
from logless.sandbox.export import COLUMNS, SIGNALS

SNAP = "snap_20260926T120000_abcd"
CLUSTERS = [
    {"id": "cat_aaaaaa", "parent_id": None, "level": 1, "is_other": False, "theme_ids": []},
    {"id": "cat_bbbbbb", "parent_id": None, "level": 1, "is_other": False, "theme_ids": []},
    {"id": "cl_111111", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False, "theme_ids": ["t1", "t2"]},
    {"id": "cl_222222", "parent_id": "cat_aaaaaa", "level": 2, "is_other": False, "theme_ids": ["t3"]},
    {"id": "cl_333333", "parent_id": "cat_bbbbbb", "level": 2, "is_other": False, "theme_ids": ["t4"]},
    {"id": "cl_other", "parent_id": "cat_bbbbbb", "level": 2, "is_other": True, "theme_ids": ["other"]},
]
LEAVES = sorted(c["id"] for c in CLUSTERS if c["level"] == 2)
CATS = sorted(c["id"] for c in CLUSTERS if c["level"] == 1)
PARENT = {c["id"]: c["parent_id"] for c in CLUSTERS}


def make_df(n: int = 120, seed: int = 1, users: int = 25) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    leaf = rng.choice(LEAVES, size=n, p=[0.4, 0.3, 0.2, 0.1])
    df = pd.DataFrame({"row": np.arange(1, n + 1), "user": rng.integers(1, users + 1, size=n), "leaf_id": leaf,
                       "category_id": [PARENT[x] for x in leaf]})
    for s in SIGNALS:
        df[s] = rng.choice(["observed", "not_observed", "unclear"], size=n, p=[0.2, 0.65, 0.15])
    return df[COLUMNS]


def dumps(doc) -> str:
    return json.dumps(doc)


@pytest.fixture()
def tmp_data(tmp_path, monkeypatch):
    """Point settings() at an empty temp data dir and reset per-thread DB connections."""
    monkeypatch.setenv("LOGLESS_DATA_DIR", str(tmp_path))
    settings.cache_clear()
    db._local.cons = {}
    yield tmp_path
    for con in getattr(db._local, "cons", {}).values():
        con.close()
    db._local.cons = {}
    settings.cache_clear()
