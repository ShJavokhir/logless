"""Search over published clusters: one Jev call per query, one tri-state choice per published leaf.

Jev sees the analyst's query and each leaf's PUBLIC title and description — never records. A
Synthetic snapshots use Choice confidence; legacy snapshots use the top probability cutoff.
Results are cached per
(snapshot, normalized query)."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict

from ..config import JEV_CONFIDENCE_CUTOFF
from ..providers import jev

CRITERIA = {
    "relevant": "The cluster's title or description clearly covers what the analyst is looking for",
    "not_relevant": "The cluster is about something else",
    "unclear": "The cluster might partly match, but it cannot be told from its title and description",
}
_cache: OrderedDict[tuple[str, str], list[dict]] = OrderedDict()
_lock = threading.Lock()
CACHE_MAX = 512


def normalize(q: str) -> str:
    return " ".join(q.lower().split())


def _questions(leaves: list[dict]) -> dict[str, dict]:
    return {n["id"]: {"type": "choice",
                      "instructions": f"Is the published workflow cluster `clusters.{n['id']}` relevant to what the analyst "
                                      f"searches for in `query`?",
                      "criteria": CRITERIA} for n in leaves}


JEV_TIMEOUT_S = 8.0
JEV_ATTEMPTS = 2


def cache_key(snapshot_id: str, query: str) -> tuple[str, str]:
    return (snapshot_id, normalize(query))


def cached(key: tuple[str, str]) -> list[dict] | None:
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def run(snapshot: dict, query: str) -> tuple[list[dict], int]:
    """One Jev call for this query (no cache lookup). Returns (results, elapsed_ms) and caches."""
    key = cache_key(snapshot["snapshot_id"], query)
    leaves = snapshot["clusters"]
    state = {"query": key[1], "clusters": {n["id"]: {"title": n["title"], "description": n["description"]} for n in leaves}}
    t0 = time.monotonic()
    synthetic = snapshot.get("dataset", {}).get("synthetic") is True
    if synthetic:
        answers = jev.evaluate(state, _questions(leaves), timeout=JEV_TIMEOUT_S, attempts=JEV_ATTEMPTS)["answers"]
    else:
        answers = jev.ask(state, _questions(leaves), use_cache=False, timeout=JEV_TIMEOUT_S, attempts=JEV_ATTEMPTS)
    elapsed = int((time.monotonic() - t0) * 1000)
    results = []
    for n in leaves:
        answer = answers[n["id"]]
        if synthetic:
            raw, p = jev.top(answer)
            choice = raw if answer["confidence"] >= JEV_CONFIDENCE_CUTOFF else "unclear"
        else:
            choice, raw, p = jev.tri_state(answer, JEV_CONFIDENCE_CUTOFF)
        if choice not in CRITERIA:
            choice = "unclear"
        results.append({"cluster_id": n["id"], "relevance": choice, "p": round(p, 4)})
    order = {"relevant": 0, "unclear": 1, "not_relevant": 2}
    results.sort(key=lambda r: (order[r["relevance"]], -r["p"] if r["relevance"] == "relevant" else 0, r["cluster_id"]))
    with _lock:
        _cache[key] = results
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return results, elapsed


def search(snapshot: dict, query: str) -> tuple[list[dict], int, bool]:
    """(results, elapsed_ms, cached) — synchronous helper without coalescing or budget."""
    hit = cached(cache_key(snapshot["snapshot_id"], query))
    if hit is not None:
        return hit, 0, True
    results, elapsed = run(snapshot, query)
    return results, elapsed, False
