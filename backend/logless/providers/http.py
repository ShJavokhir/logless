"""Shared HTTP plumbing: pooled client, retries with backoff, response cache.

Quiet logs: request and response bodies are never logged — only provider, status,
latency and error codes."""
from __future__ import annotations

import hashlib
import json
import logging
import random
import threading
import time
from typing import Any

import httpx

from .. import db
from ..ids import utcnow

log = logging.getLogger("logless.providers")

_client: httpx.Client | None = None
_client_lock = threading.Lock()
RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 529}


class ProviderError(RuntimeError):
    def __init__(self, provider: str, status: int | None, code: str):
        super().__init__(f"{provider} error status={status} code={code}")
        self.provider, self.status, self.code = provider, status, code


def client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=httpx.Timeout(120.0, connect=10.0),
                limits=httpx.Limits(max_connections=64, max_keepalive_connections=32),
            )
        return _client


def post_json(provider: str, url: str, key: str, body: dict, *, attempts: int = 5, timeout: float | None = None) -> dict:
    """POST with retries on transient failures. Returns the parsed JSON body."""
    if not key:
        raise ProviderError(provider, None, "missing_api_key")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last: ProviderError | None = None
    for attempt in range(attempts):
        t0 = time.monotonic()
        try:
            r = client().post(url, headers=headers, json=body, timeout=timeout or httpx.USE_CLIENT_DEFAULT)
        except httpx.TransportError as e:
            last = ProviderError(provider, None, type(e).__name__)
        else:
            dt = time.monotonic() - t0
            if r.status_code < 400:
                log.debug("%s ok status=%s %.2fs", provider, r.status_code, dt)
                return r.json()
            last = ProviderError(provider, r.status_code, _error_code(r))
            log.warning("%s status=%s code=%s %.2fs attempt=%d", provider, r.status_code, last.code, dt, attempt + 1)
            if r.status_code not in RETRY_STATUS:
                raise last
        time.sleep(min(30.0, (2 ** attempt) * 0.75 + random.random() * 0.5))
    assert last is not None
    raise last


def _error_code(r: httpx.Response) -> str:
    try:
        data = r.json()
    except Exception:
        return "non_json"
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return str(err.get("code") or err.get("type") or "error")[:64]
    return str(err or "error")[:64]


# ---------------------------------------------------------------- cache

def cache_key(provider: str, body: dict) -> str:
    return hashlib.sha256((provider + "\n" + json.dumps(body, sort_keys=True, ensure_ascii=False)).encode()).hexdigest()


def cache_get(key: str) -> Any | None:
    row = db.private().execute("SELECT response FROM llm_cache WHERE key=?", (key,)).fetchone()
    return json.loads(row["response"]) if row else None


def cache_put(key: str, provider: str, model: str, response: Any) -> None:
    con = db.private()
    with db.write(con):
        con.execute(
            "INSERT OR REPLACE INTO llm_cache(key, provider, model, response, created_at) VALUES (?,?,?,?,?)",
            (key, provider, model, json.dumps(response, ensure_ascii=False), utcnow()),
        )
