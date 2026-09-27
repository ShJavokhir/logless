"""Validated, atomic JSONL chat import into a new private workspace.

This adapter accepts text conversations, not arbitrary datasets. Metadata is deliberately
separate from private records because its allowlisted fields will appear in the public UI.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .. import db
from ..config import settings
from ..ids import conversation_id, user_pseudonym
from .languages import canonical_language
from .wildchat import render, was_truncated

MAX_BYTES = 100 * 1024 * 1024
MAX_RECORDS = 50_000
MAX_LINE_BYTES = 1024 * 1024
SCHEMA = "CREATE TABLE IF NOT EXISTS source_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), json TEXT NOT NULL)"


class ImportError(ValueError):
    """An operator-safe error: never includes private record values or model prompts."""


class SourceMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=60)
    workspace_name: str = Field(min_length=1, max_length=120)
    workspace_description: str = Field(min_length=1, max_length=600)
    source_url: str = Field(default="", max_length=200)
    revision: str = Field(min_length=1, max_length=64)
    license: str = Field(min_length=1, max_length=40)
    attribution: str = Field(min_length=1, max_length=400)
    people_note: str = Field(min_length=1, max_length=200)
    intended_uses: list[str] = Field(min_length=1, max_length=20)

    @field_validator("name", "workspace_name", "workspace_description", "revision", "license", "attribution", "people_note")
    @classmethod
    def public_text(cls, value: str) -> str:
        from ..pipeline.privacy import contact_hits, source_id_hits
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value) or contact_hits(value) or source_id_hits(value):
            raise ValueError("metadata must contain public text without contact or private identifiers")
        return value

    @field_validator("intended_uses")
    @classmethod
    def uses(cls, values: list[str]) -> list[str]:
        if any(not 1 <= len(value) <= 120 for value in values):
            raise ValueError("intended uses must have 1–120 characters")
        return [cls.public_text(value) for value in values]

    @field_validator("source_url")
    @classmethod
    def url(cls, value: str) -> str:
        if not value:
            return value
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or any(c.isspace() for c in value)):
            raise ValueError("source_url must be an HTTPS public attribution URL without credentials, query or fragment")
        return value


def metadata() -> dict | None:
    """None identifies the pinned WildChat adapter; imported workspaces carry explicit metadata."""
    con = db.private()
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_metadata'").fetchone() is None:
        return None
    row = con.execute("SELECT json FROM source_metadata WHERE singleton = 1").fetchone()
    return json.loads(row["json"]) if row else None


def _load_metadata(path: Path) -> dict:
    if path.stat().st_size > 32_768:
        raise ImportError("metadata exceeds 32 KiB")
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_strict_object, parse_constant=_reject_constant)
        _validate_unicode(parsed)
        return SourceMetadata.model_validate(parsed).model_dump()
    except (ValidationError, UnicodeError, ValueError):
        raise ImportError("invalid public metadata; see docs/DATA_IMPORT.md for required fields and limits") from None


def _strict_object(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value: str):
    raise ValueError("nonfinite JSON number")


def _validate_unicode(value: object) -> None:
    """JSON escapes can create lone surrogates despite valid UTF-8 source bytes.

    Reject every such string (including object keys) before opening SQLite, hashing IDs,
    serializing metadata, or truncating message text. Valid surrogate pairs decode normally.
    """
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            item.encode("utf-8", errors="strict")
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)


def _string(row: dict, key: str, limit: int, *, optional: bool = False,
            preserve: bool = False) -> str | None:
    value = row.get(key)
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ImportError(f"invalid {key} field")
    return value if preserve else value.strip()


def _record(row: object, rank: int, salt: str) -> tuple:
    required = {"id", "user_id", "messages"}
    if not isinstance(row, dict) or not required <= row.keys() or row.keys() - (required | {"language", "timestamp", "model"}):
        raise ImportError("record must contain id, user_id and messages; optional fields are language, timestamp and model")
    source_id = _string(row, "id", 512, preserve=True)
    user_id = _string(row, "user_id", 512, preserve=True)
    language = canonical_language(_string(row, "language", 60, optional=True))
    model = _string(row, "model", 120, optional=True)
    messages = row["messages"]
    if not isinstance(messages, list) or not 1 <= len(messages) <= 1000:
        raise ImportError("messages must contain 1–1000 text messages")
    for message in messages:
        if (not isinstance(message, dict) or set(message) != {"role", "content"}
                or message["role"] not in ("user", "assistant", "system", "developer", "tool")
                or not isinstance(message["content"], str) or "\x00" in message["content"]):
            raise ImportError("each message requires a supported role and string content")
    turns = sum(m["role"] == "user" and bool(m["content"].strip()) for m in messages)
    if not turns:
        raise ImportError("conversation requires at least one nonempty user message")
    stamp = _string(row, "timestamp", 40, optional=True)
    if stamp is not None:
        try:
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            raise ImportError("timestamp must be ISO 8601 with an explicit time zone") from None
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ImportError("timestamp must include a time zone")
        stamp = parsed.astimezone(timezone.utc).isoformat()
    # No source identifiers are retained; the existing integer column is an adapter-local ordinal.
    cid = conversation_id("jsonl:" + source_id)
    return (cid, rank, rank, rank, user_pseudonym(user_id, salt), language, turns, model, None,
            stamp, render(messages), int(was_truncated(messages)))


def load_jsonl(source: Path, metadata_path: Path) -> dict:
    s = settings()
    if any(s.data_dir.iterdir()):
        raise ImportError("import requires an empty data directory; choose a new --data-dir")
    if not s.pseudonym_salt:
        raise ImportError("PSEUDONYM_SALT must be set before importing")
    if source.stat().st_size > MAX_BYTES:
        raise ImportError("dataset exceeds the 100 MiB import limit")
    meta = _load_metadata(metadata_path)
    rows, seen = [], set()
    digest = hashlib.sha256()
    consumed = 0
    with source.open("rb") as stream:
        number = 0
        while raw := stream.readline(MAX_LINE_BYTES + 1):
            number += 1
            if len(raw) > MAX_LINE_BYTES:
                raise ImportError(f"line {number}: exceeds the 1 MiB record limit")
            consumed += len(raw)
            if consumed > MAX_BYTES:
                raise ImportError("dataset exceeds the 100 MiB import limit")
            digest.update(raw)
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object, parse_constant=_reject_constant)
                _validate_unicode(obj)
                row = _record(obj, len(rows), s.pseudonym_salt)
            except (ValueError, UnicodeError, TypeError):
                raise ImportError(f"line {number}: invalid conversation; see docs/DATA_IMPORT.md") from None
            if row[0] in seen:
                raise ImportError(f"line {number}: duplicate conversation id")
            seen.add(row[0])
            rows.append(row)
            if len(rows) > MAX_RECORDS:
                raise ImportError("dataset exceeds the 50,000 conversation import limit")
    if not rows:
        raise ImportError("dataset contains no conversations")
    meta.update({"adapter": "jsonl-v1", "source_sha256": digest.hexdigest(), "imported_conversations": len(rows)})
    # Validation completed before opening SQLite; the dataset and its provenance commit together.
    os.chmod(s.data_dir, 0o700)
    con = db.private()
    con.execute(SCHEMA)
    with db.write(con):
        con.executemany(
            "INSERT INTO conversations(conv_id, turn_identifier, source_row, sample_rank, user_id, language, turns, model, "
            "country, ts, text, truncated, is_fixture) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)", rows)
        con.execute("INSERT INTO source_metadata(singleton, json) VALUES (1,?)", (json.dumps(meta, ensure_ascii=False),))
    for path in s.data_dir.glob("private.db*"):
        os.chmod(path, 0o600)
    return {"conversations": len(rows), "users": len({r[4] for r in rows}),
            "truncated": sum(r[11] for r in rows), "source_sha256": meta["source_sha256"]}
