"""SQLite storage. private.db holds everything per-conversation; public.db holds only
what may reach a browser (see docs/CONTRACTS.md §4)."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from .config import settings

PRIVATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  conv_id TEXT PRIMARY KEY,
  turn_identifier INTEGER NOT NULL,
  source_row INTEGER,
  sample_rank INTEGER,
  user_id TEXT NOT NULL,
  language TEXT,
  turns INTEGER,
  model TEXT,
  country TEXT,
  ts TEXT,
  text TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  is_fixture INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS facets (
  conv_id TEXT PRIMARY KEY,
  user_goal TEXT, task TEXT, domain TEXT, language TEXT,
  facet_text TEXT,
  model TEXT, prompt_version TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS friction (
  conv_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  choice TEXT NOT NULL,          -- observed | not_observed | unclear (after cutoff)
  raw_choice TEXT NOT NULL,      -- Jev's top choice before the cutoff
  p REAL NOT NULL,
  model TEXT, question_version TEXT, created_at TEXT,
  PRIMARY KEY (conv_id, signal)
);
CREATE TABLE IF NOT EXISTS themes (
  build_id TEXT NOT NULL,
  theme_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  includes TEXT,
  excludes TEXT,
  category_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (build_id, theme_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  build_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  theme_id TEXT NOT NULL,        -- 'other' for Other or unclear
  p REAL,
  round INTEGER NOT NULL,
  PRIMARY KEY (build_id, conv_id)
);
CREATE TABLE IF NOT EXISTS builds (
  build_id TEXT PRIMARY KEY,
  started_at TEXT, finished_at TEXT,
  status TEXT,
  stages_json TEXT,
  snapshot_id TEXT
);
CREATE TABLE IF NOT EXISTS eval_fixtures (
  conv_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- canary | injection
  tokens_json TEXT NOT NULL      -- strings that must never be published
);
CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  provider TEXT, model TEXT,
  response TEXT NOT NULL,
  created_at TEXT
);
"""

PUBLIC_SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  intent TEXT,
  snapshot_id TEXT,
  state TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stories (
  snapshot_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, cluster_id)
);
CREATE TABLE IF NOT EXISTS prds (
  snapshot_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, cluster_id)
);
CREATE TABLE IF NOT EXISTS briefs (
  brief_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS briefs_snapshot ON briefs(snapshot_id, created_at);
CREATE TABLE IF NOT EXISTS eval_reports (
  snapshot_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

_local = threading.local()
_write_lock = threading.Lock()


def _connect(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _get(name: str, path: Path, schema: str) -> sqlite3.Connection:
    cons = getattr(_local, "cons", None)
    if cons is None:
        cons = _local.cons = {}
    paths = getattr(_local, "paths", None)
    if paths is None:
        paths = _local.paths = {}
    con = cons.get(name)
    if con is not None and paths.get(name) != path:
        if con.in_transaction:
            raise RuntimeError("cannot change data directories with an open database transaction")
        con.close()
        cons.pop(name, None)
        paths.pop(name, None)
        con = None
    if con is None:
        path.parent.mkdir(parents=True, exist_ok=True)
        con = _connect(path)
        try:
            con.executescript(schema)
        except Exception:
            con.close()
            raise
        cons[name] = con
        paths[name] = path
    return con


def private() -> sqlite3.Connection:
    """Per-thread connection to private.db (backend only)."""
    return _get("private", settings().private_db, PRIVATE_SCHEMA)


def public() -> sqlite3.Connection:
    """Per-thread connection to public.db (browser-safe content only)."""
    return _get("public", settings().public_db, PUBLIC_SCHEMA)


@contextmanager
def write(con: sqlite3.Connection):
    """Serialize writers across threads and commit on success."""
    with _write_lock:
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
