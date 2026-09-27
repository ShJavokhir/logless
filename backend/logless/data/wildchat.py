"""The hardcoded input: a seeded sample of WildChat-1M shard 0 (docs/CONTRACTS.md §1)."""
from __future__ import annotations

import hashlib
import logging
import random
from pathlib import Path

import httpx
import pyarrow.parquet as pq

from .. import db
from ..config import DATASET_FILE, DATASET_ID, DATASET_REVISION, settings
from ..ids import conversation_id, user_pseudonym

log = logging.getLogger("logless.data")

MSG_CAP = 3000
CONV_CAP = 16000
COLUMNS = ["conversation", "turn", "language", "hashed_ip", "country", "timestamp", "model"]


def shard_path() -> Path:
    return settings().raw_dir / f"wildchat-1m-{DATASET_REVISION[:8]}-train-00000.parquet"


def download(force: bool = False) -> Path:
    """Download the pinned shard once (~231 MB)."""
    path = shard_path()
    if path.exists() and not force:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/datasets/{DATASET_ID}/resolve/{DATASET_REVISION}/{DATASET_FILE}"
    tmp = path.with_suffix(".part")
    log.info("downloading %s", url)
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(600, connect=20)) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    tmp.rename(path)
    return path


def render(conversation: list[dict]) -> str:
    """`role: content` lines with per-message and whole-conversation caps."""
    parts = []
    for m in conversation:
        c = (m.get("content") or "").strip()
        if len(c) > MSG_CAP:
            c = c[: MSG_CAP - 600] + " […] " + c[-500:]
        parts.append(f"{m.get('role', 'user')}: {c}")
    text = "\n".join(parts)
    if len(text) > CONV_CAP:
        text = text[: CONV_CAP - 4200] + "\n[… middle of conversation omitted …]\n" + text[-4000:]
    return text


def was_truncated(conversation: list[dict]) -> bool:
    full = "\n".join(f"{m.get('role', 'user')}: {(m.get('content') or '').strip()}" for m in conversation)
    return render(conversation) != full


def load_sample(n: int | None = None, seed: int | None = None) -> int:
    """Sample n conversations and store them in private.db. Idempotent for the same (n, seed)."""
    s = settings()
    from .importer import metadata
    if metadata() is not None:
        raise ValueError("WildChat seed cannot replace an imported dataset; choose a separate LOGLESS_DATA_DIR")
    n = s.sample_size if n is None else n
    if n < 1:
        raise ValueError("sample size must be positive")
    seed = seed if seed is not None else s.sample_seed
    table = pq.read_table(download(), columns=COLUMNS)
    convs = table.column("conversation").to_pylist()
    eligible = [i for i, c in enumerate(convs) if c and c[0].get("role") == "user" and (c[0].get("content") or "").strip()]
    rng = random.Random(seed)
    picked = rng.sample(eligible, min(n, len(eligible)))
    cols = {name: table.column(name).to_pylist() for name in COLUMNS if name != "conversation"}
    rows = []
    for rank, i in enumerate(picked):
        conv = convs[i]
        tid = conv[0]["turn_identifier"]
        ts = cols["timestamp"][i]
        rows.append((
            conversation_id(tid), int(tid), i, rank,
            user_pseudonym(cols["hashed_ip"][i] or f"missing-{i}", s.pseudonym_salt),
            cols["language"][i], int(cols["turn"][i]), cols["model"][i], cols["country"][i],
            ts.isoformat() if ts is not None else None, render(conv), int(was_truncated(conv)),
        ))
    con = db.private()
    with db.write(con):
        con.execute("DELETE FROM conversations WHERE is_fixture = 0")
        con.executemany(
            "INSERT OR REPLACE INTO conversations(conv_id, turn_identifier, source_row, sample_rank, user_id, language, turns, model, country, ts, text, truncated, is_fixture)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)", rows)
    log.info("stored %d sampled conversations (eligible %d)", len(rows), len(eligible))
    return len(rows)


def dataset_hash() -> str:
    """Hash of the exact conversation set (ids + text) that a build ran on."""
    h = hashlib.sha256(DATASET_REVISION.encode())
    for row in db.private().execute("SELECT conv_id, text FROM conversations ORDER BY conv_id"):
        h.update(row["conv_id"].encode())
        h.update(hashlib.sha256(row["text"].encode()).digest())
    return h.hexdigest()[:16]
