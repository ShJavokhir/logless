"""Pipeline plumbing: build context, artifacts, thread pools, usage accounting.

Quiet logs: only counts, stage names, model ids and error type names are logged — never prompts,
completions, facets or conversation text."""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import CancelledError, FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar

from .. import db
from ..config import GLM, GLM_FLASH, JEV, settings
from ..providers import glm, jev
from ..providers.http import ProviderError, cache_get, cache_key

log = logging.getLogger("logless.pipeline")
T = TypeVar("T")

# USD per million tokens (input, output) from the Vultr catalog snapshot of 2026-09-26.
PRICES = {GLM_FLASH: (0.10, 0.35), GLM: (0.75, 3.00)}


def no_cache() -> bool:
    """`logless rebuild --no-cache` / LOGLESS_NO_CACHE=1: fresh model and embedding calls, and per-conversation
    facets/friction are recomputed instead of reused (cache writes still happen)."""
    import os
    return os.environ.get("LOGLESS_NO_CACHE", "").strip().lower() in ("1", "true", "yes")


# ---------------------------------------------------------------- build context

@dataclass
class Build:
    build_id: str
    limit: int | None
    conv_ids: list[str]
    started_at: str
    stages: list[dict] = field(default_factory=list)
    info: dict = field(default_factory=dict)

    @property
    def dir(self) -> Path:
        d = settings().artifacts_dir / self.build_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save(self, name: str, obj: Any) -> None:
        p = self.dir / f"{name}.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1, default=_default))
        tmp.replace(p)

    def load(self, name: str, default: Any = None) -> Any:
        p = self.dir / f"{name}.json"
        if not p.exists():
            if default is not None:
                return default
            raise FileNotFoundError(f"artifact {name} missing for {self.build_id}; run the earlier stage first")
        return json.loads(p.read_text())

    def has(self, name: str) -> bool:
        return (self.dir / f"{name}.json").exists()


def _default(o: Any) -> Any:
    try:
        import numpy as np
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:  # pragma: no cover
        pass
    raise TypeError(type(o).__name__)


# ---------------------------------------------------------------- usage accounting

class Usage:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.stage = "setup"
        self.rows: dict[tuple[str, str, str], dict[str, float]] = {}

    def add(self, provider: str, model: str, *, prompt: float = 0, completion: float = 0, cached: bool = False,
            estimated: bool = False) -> None:
        with self.lock:
            r = self.rows.setdefault((self.stage, provider, model),
                                     {"calls": 0, "cached": 0, "prompt_tokens": 0, "completion_tokens": 0, "estimated": 0})
            r["calls"] += 1
            if cached:
                r["cached"] += 1
            else:
                r["prompt_tokens"] += prompt
                r["completion_tokens"] += completion
                r["estimated"] = int(r["estimated"] or estimated)

    def summary(self) -> list[dict]:
        out = []
        with self.lock:
            for (stage, provider, model), r in sorted(self.rows.items()):
                price = PRICES.get(model)
                cost = None
                if price:
                    cost = round((r["prompt_tokens"] * price[0] + r["completion_tokens"] * price[1]) / 1e6, 4)
                out.append({"stage": stage, "provider": provider, "model": model, **{k: int(v) for k, v in r.items()},
                            "usd": cost})
        return out


USAGE = Usage()


def glm_json(system: str, user: str, schema: type[T], *, model: str = GLM, reasoning: glm.Reasoning = "off",
             temperature: float = 0.2, max_tokens: int = 1200, retries: int = 2, patience: int = 4) -> T:
    """chat_json + usage accounting. On a rate limit that outlasts the provider's own retries, wait and
    try again up to `patience` more times (low-volume pipeline calls must not silently degrade)."""
    for attempt in range(patience + 1):
        try:
            out, meta = glm.chat_json(system, user, schema, model=model, reasoning=reasoning, temperature=temperature,
                                      max_tokens=max_tokens, retries=retries)
            break
        except ProviderError as e:
            if e.status != 429 or attempt == patience:
                raise
            time.sleep(20 + 10 * attempt)
    u = meta.get("usage") or {}
    USAGE.add("glm", model, prompt=u.get("prompt_tokens") or 0, completion=u.get("completion_tokens") or 0,
              cached=bool(meta.get("cached")))
    return out


def jev_ask(state: Any, questions: dict[str, dict]) -> dict[str, dict]:
    body = {"model": JEV, "state": state, "questions": questions}
    hit = cache_get(cache_key("jev", body))
    if hit is not None:
        jev.validate_answers(hit, questions)
        USAGE.add("jev", JEV, cached=True)
        return hit
    ans = jev.ask(state, questions)
    est = len(json.dumps(body, ensure_ascii=False)) / 4
    USAGE.add("jev", JEV, prompt=est, completion=12 * len(questions), estimated=True)
    return ans


# ---------------------------------------------------------------- parallelism

FAIL_FAST_AFTER = 5   # consecutive account-level provider failures (401/402/403) before a stage aborts


class ProviderUnavailable(RuntimeError):
    """A provider refuses every call (auth, billing): the stage stops instead of burning through its items."""

    def __init__(self, provider: str, code: str):
        super().__init__(f"{provider} unavailable: {code}")
        self.provider, self.code = provider, code


def pmap(fn: Callable[[Any], T], items: list, threads: int, label: str) -> tuple[list[T | None], int]:
    """Run fn over items in a thread pool. Returns (results in order, error count); failed items are None.
    Raises ProviderUnavailable after FAIL_FAST_AFTER consecutive account-level provider failures (the
    remaining items are not attempted)."""
    results: list[T | None] = [None] * len(items)
    errors = 0
    if not items:
        return results, 0
    t0 = time.monotonic()
    step = max(1, len(items) // 10)
    abort = threading.Event()

    def guarded(it):
        if abort.is_set():
            raise _Skipped()
        return fn(it)

    fatal: ProviderError | None = None
    consecutive = 0
    with ThreadPoolExecutor(max_workers=threads) as ex:
        # Keep only one window in flight. Submitting the whole corpus lets quick failures
        # consume every item before the observer has a chance to trigger the circuit breaker.
        next_item = 0
        futs = {}
        n = 0
        while futs or (next_item < len(items) and not abort.is_set()):
            while not abort.is_set() and len(futs) < threads and next_item < len(items):
                futs[ex.submit(guarded, items[next_item])] = next_item
                next_item += 1
            done, _ = wait(futs, return_when=FIRST_COMPLETED)
            for f in done:
                i = futs.pop(f)
                n += 1
                try:
                    results[i] = f.result()
                    consecutive = 0
                except (_Skipped, CancelledError):
                    continue
                except Exception as e:  # quiet: type and provider code only
                    errors += 1
                    code = e.code if isinstance(e, ProviderError) else ""
                    if isinstance(e, ProviderError) and e.fatal:
                        consecutive += 1
                        fatal = e
                        if consecutive >= min(FAIL_FAST_AFTER, len(items)) and not abort.is_set():
                            abort.set()
                            for other in futs:
                                other.cancel()
                    else:
                        consecutive = 0
                    if not abort.is_set() or consecutive <= FAIL_FAST_AFTER:
                        log.warning("%s: item failed (%s %s)", label, type(e).__name__, code)
                if n % step == 0 or n == len(items):
                    log.info("%s: %d/%d done, %d errors, %.1fs", label, n, len(items), errors, time.monotonic() - t0)
    if abort.is_set() and fatal is not None:
        log.error("%s: aborted after %d consecutive %s failures (%s)", label, FAIL_FAST_AFTER, fatal.provider, fatal.code)
        raise ProviderUnavailable(fatal.provider, fatal.code)
    return results, errors


class _Skipped(Exception):
    pass


def chunks(xs: list, n: int) -> Iterable[list]:
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def load_rows(conv_ids: list[str], sql: str) -> dict[str, Any]:
    """Fetch rows keyed by conv_id for the given ids (sql must select conv_id and use `IN ({})`)."""
    out: dict[str, Any] = {}
    con = db.private()
    for chunk in chunks(conv_ids, 900):
        for row in con.execute(sql.format(",".join("?" * len(chunk))), chunk):
            out[row["conv_id"]] = row
    return out


def words(s: str) -> int:
    return len(s.split())


def clip_words(s: str, n: int) -> str:
    w = s.split()
    return s if len(w) <= n else " ".join(w[:n])
