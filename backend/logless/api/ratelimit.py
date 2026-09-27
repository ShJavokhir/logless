"""In-memory per-IP token buckets and a global hourly budget (single-process API; good enough
for a public demo)."""
from __future__ import annotations

import collections
import os
import threading
import time
from dataclasses import dataclass

# bucket name -> (capacity, refill tokens per second)
LIMITS: dict[str, tuple[float, float]] = {
    "default": (60, 10.0),         # snapshot, run polling, health, eval
    "search": (8, 1.0),
    "canvas": (6, 1 / 5),
    "analysis": (4, 1 / 15),
    "story": (6, 1 / 10),
    "prd": (6, 1 / 10),
    "brief": (6, 1 / 10),
    "containment": (2, 1 / 30),
}
MAX_KEYS = 20_000


@dataclass
class _Bucket:
    tokens: float
    ts: float


class RateLimiter:
    def __init__(self, limits: dict[str, tuple[float, float]] | None = None):
        self.limits = limits or LIMITS
        self.buckets: dict[tuple[str, str], _Bucket] = {}
        self.lock = threading.Lock()

    def allow(self, ip: str, bucket: str) -> bool:
        cap, rate = self.limits.get(bucket, self.limits["default"])
        now = time.monotonic()
        with self.lock:
            if len(self.buckets) > MAX_KEYS:
                self.buckets.clear()
            b = self.buckets.get((ip, bucket))
            if b is None:
                b = self.buckets[(ip, bucket)] = _Bucket(cap, now)
            b.tokens = min(cap, b.tokens + (now - b.ts) * rate)
            b.ts = now
            if b.tokens >= 1:
                b.tokens -= 1
                return True
            return False


# ---------------------------------------------------------------- global provider budget

BUDGET_DEFAULTS: dict[str, tuple[str, int, str]] = {
    # kind: (env var, default per hour, label shown to people)
    "search": ("LOGLESS_BUDGET_SEARCH_PER_HOUR", 600, "searches"),
    "canvas": ("LOGLESS_BUDGET_CANVAS_PER_HOUR", 120, "generated views"),
    "analysis": ("LOGLESS_BUDGET_ANALYSES_PER_HOUR", 120, "live analyses"),
    "story": ("LOGLESS_BUDGET_STORIES_PER_HOUR", 60, "user stories"),
    "prd": ("LOGLESS_BUDGET_PRDS_PER_HOUR", 60, "PRD drafts"),
    "brief": ("LOGLESS_BUDGET_BRIEFS_PER_HOUR", 30, "video briefs"),
    "containment": ("LOGLESS_BUDGET_CONTAINMENT_PER_HOUR", 60, "containment checks"),
}
WINDOW_S = 3600.0


PRESENTER_BUDGET_DEFAULTS: dict[str, tuple[str, int]] = {
    "search": ("PRESENTER_BUDGET_SEARCH", 300),
    "canvas": ("PRESENTER_BUDGET_CANVAS", 60),
    "analysis": ("PRESENTER_BUDGET_ANALYSES", 60),
    "story": ("PRESENTER_BUDGET_STORIES", 30),
    "prd": ("PRESENTER_BUDGET_PRDS", 30),
    "brief": ("PRESENTER_BUDGET_BRIEFS", 20),
    "containment": ("PRESENTER_BUDGET_CONTAINMENT", 30),
}


def presenter_limits() -> dict[str, int]:
    return {k: max(0, int(os.environ.get(env, default))) for k, (env, default) in PRESENTER_BUDGET_DEFAULTS.items()}


class HourlyBudget:
    """Global (all visitors) sliding-window caps on calls that cost provider or sandbox time.
    Cached answers and in-flight coalescing never consume budget."""

    def __init__(self, limits: dict[str, int] | None = None):
        self.limits = limits if limits is not None else {
            k: max(0, int(os.environ.get(env, default))) for k, (env, default, _) in BUDGET_DEFAULTS.items()}
        self.events: dict[str, collections.deque[float]] = {k: collections.deque() for k in self.limits}
        self.lock = threading.Lock()

    def take(self, kind: str) -> int | None:
        """Consume one unit. Returns None if allowed, else the seconds until one frees up."""
        now = time.monotonic()
        with self.lock:
            q = self.events.setdefault(kind, collections.deque())
            while q and now - q[0] >= WINDOW_S:
                q.popleft()
            if len(q) >= self.limits.get(kind, 0):
                return max(1, int(WINDOW_S - (now - q[0])) + 1) if q else int(WINDOW_S)
            q.append(now)
            return None

    def remaining(self, kind: str) -> int:
        now = time.monotonic()
        with self.lock:
            q = self.events.get(kind) or collections.deque()
            return max(0, self.limits.get(kind, 0) - sum(1 for t in q if now - t < WINDOW_S))

    @staticmethod
    def label(kind: str) -> str:
        return BUDGET_DEFAULTS.get(kind, ("", 0, kind))[2]
