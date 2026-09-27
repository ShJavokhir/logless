"""Identifier formats from docs/CONTRACTS.md §2."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timezone


def conversation_id(turn_identifier: int | str) -> str:
    return "c_" + hashlib.sha256(f"conv:{turn_identifier}".encode()).hexdigest()[:12]


def user_pseudonym(hashed_ip: str, salt: str) -> str:
    if not salt:
        raise RuntimeError("PSEUDONYM_SALT is not set")
    return "u_" + hmac.new(salt.encode(), hashed_ip.encode(), hashlib.sha256).hexdigest()[:10]


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def build_id() -> str:
    return "b_" + _stamp()


def snapshot_id() -> str:
    return f"snap_{_stamp()}_{secrets.token_hex(2)}"


def run_id() -> str:
    return "run_" + secrets.token_hex(6)


def brief_id() -> str:
    return "brf_" + secrets.token_hex(6)


def short_hex(seed: str, n: int = 6) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()[:n]


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
