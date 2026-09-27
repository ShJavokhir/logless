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


def evaluate(state: Any, questions: dict[str, dict], *, timeout: float = 30, attempts: int = 3) -> dict:
    """Uncached typed Choice evaluation retaining the actual model, confidence and token usage."""
    import math
    out = post_json("jev", TYPESAFE_URL, settings().typesafe_api_key,
                    {"model": JEV, "state": state, "questions": questions}, timeout=timeout, attempts=attempts)
    answers = out.get("answers")
    if not isinstance(out.get("model"), str) or not isinstance(answers, dict) or set(answers) != set(questions):
        raise ProviderError("jev", None, "malformed_answers")
    for name, question in questions.items():
        a = answers[name]
        choices = question["criteria"]
        if not isinstance(a, dict) or not isinstance(a.get("probabilities"), dict):
            raise ProviderError("jev", None, "malformed_choice")
        probs = a.get("probabilities", {})
        if (a.get("type") != "choice" or a.get("choice") not in choices or set(probs) != set(choices)
                or any(type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in probs.values())
                or abs(sum(probs.values()) - 1) > 0.015
                or type(a.get("confidence")) not in (int, float) or not 0 <= a["confidence"] <= 1
                or probs[a["choice"]] < max(probs.values()) - 1e-6):
            raise ProviderError("jev", None, "malformed_choice")
    return out
