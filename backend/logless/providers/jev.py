"""TypeSafe Jev — calibrated typed decisions (choice / score / noul).

Request: {"model": "jev-latest", "state": ..., "questions": {qid: {type, instructions, criteria}}}
Response: {"answers": {qid: {"choice", "probabilities"} | {"score", "confidence"} | {"noul", "confidence"}}, "usage": ...}
Limits (2026-09-26): 255 options per choice, 64k tokens per request, 1,200 requests/min."""
from __future__ import annotations

from typing import Any

from ..config import JEV, JEV_CONFIDENCE_CUTOFF, TYPESAFE_URL, settings
from .http import ProviderError, cache_get, cache_key, cache_put, post_json


def ask(state: Any, questions: dict[str, dict], *, use_cache: bool = True, timeout: float = 60,
        attempts: int = 5) -> dict[str, dict]:
    """Ask Jev several questions about one state in a single call. Returns the answers dict.
    Interactive callers pass a short `timeout` and few `attempts`."""
    body = {"model": JEV, "state": state, "questions": questions}
    key = cache_key("jev", body)
    if use_cache and (hit := cache_get(key)) is not None:
        return hit
    out = post_json("jev", TYPESAFE_URL, settings().typesafe_api_key, body, timeout=timeout, attempts=attempts)
    answers = out.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise ProviderError("jev", None, "malformed_answers")
    if use_cache:
        cache_put(key, "jev", JEV, answers)
    return answers


def top(answer: dict) -> tuple[str, float]:
    """(top choice, its probability) for a choice answer."""
    probs = answer.get("probabilities") or {}
    choice = answer.get("choice")
    p = float(probs.get(choice, max(probs.values()) if probs else 0.0))
    return choice, p


def tri_state(answer: dict, cutoff: float = JEV_CONFIDENCE_CUTOFF) -> tuple[str, str, float]:
    """Map a tri-state choice to (stored_choice, raw_choice, p): below the cutoff → 'unclear'."""
    raw, p = top(answer)
    return (raw if p >= cutoff else "unclear"), raw, p
