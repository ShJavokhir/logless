"""Last-line checks on text that is about to reach a browser: canary tokens planted by the
evaluation fixtures, private id shapes, and contact patterns. A hit blocks the payload."""
from __future__ import annotations

import json
import re
import threading
import time

from .. import db

PRIVATE_ID = re.compile(r"\b(?:c_[0-9a-f]{12}|u_[0-9a-f]{10}|b_\d{8}T\d{6})\b")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL = re.compile(r"(?i)\b(?:https?://|www\.)\S+")
PHONE = re.compile(r"(?:\+?\d[\s().-]?){7,}\d")

_cache: tuple[float, list[str]] = (0.0, [])
_lock = threading.Lock()


def canary_tokens(max_age_s: float = 60.0) -> list[str]:
    """Lower-cased canary strings from private.db.eval_fixtures (empty if none are planted)."""
    global _cache
    with _lock:
        ts, toks = _cache
        if time.monotonic() - ts < max_age_s and ts:
            return toks
        out: list[str] = []
        try:
            for row in db.private().execute("SELECT tokens_json FROM eval_fixtures").fetchall():
                try:
                    vals = json.loads(row["tokens_json"])
                except ValueError:
                    continue
                vals = vals.values() if isinstance(vals, dict) else vals
                out.extend(str(v).strip().lower() for v in vals if isinstance(v, (str, int)) and len(str(v).strip()) >= 4)
        except Exception:  # noqa: BLE001 — a missing table means no canaries planted yet
            out = []
        _cache = (time.monotonic(), sorted(set(out)))
        return _cache[1]


def reset_cache() -> None:
    global _cache
    with _lock:
        _cache = (0.0, [])


def problems(text: str, *, contact: bool = True) -> list[str]:
    """Reasons this text must not be served (empty list = fine). Never returns the matched text.
    `contact=False` is for whole structured payloads (hashes, timestamps, links): it skips the
    URL/phone patterns and the digit-only canaries (planted phone numbers), which could otherwise
    match by accident inside a hash or timestamp. Free-text fields are checked with contact=True."""
    found = []
    low = text.lower()
    toks = canary_tokens()
    if not contact:
        toks = [t for t in toks if re.search(r"[a-z]", t)]
    if any(tok in low for tok in toks):
        found.append("canary token")
    if PRIVATE_ID.search(text):
        found.append("private id")
    if EMAIL.search(text):
        found.append("email address")
    if contact and URL.search(text):
        found.append("url")
    if contact and PHONE.search(text):
        found.append("phone number")
    return found
