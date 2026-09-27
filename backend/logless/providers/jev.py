"""TypeSafe Jev — calibrated typed decisions (choice / score / noul).

Request: {"model": "jev-latest", "state": ..., "questions": {qid: {type, instructions, criteria}}}
Response: {"answers": {qid: {"choice", "probabilities"} | {"score", "confidence"} | {"noul", "confidence"}}, "usage": ...}
Limits (2026-09-26): 255 options per choice, 64k tokens per request, 1,200 requests/min."""
from __future__ import annotations

import math
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
        validate_answers(hit, questions)
        return hit
    out = post_json("jev", TYPESAFE_URL, settings().typesafe_api_key, body, timeout=timeout, attempts=attempts)
    answers = out.get("answers")
    validate_answers(answers, questions)
    if use_cache:
        cache_put(key, "jev", JEV, answers)
    return answers


def top(answer: dict) -> tuple[str, float]:
    """(top choice, its probability) for a choice answer."""
    if not isinstance(answer, dict):
        raise ProviderError("jev", None, "malformed_choice")
    probs = answer.get("probabilities")
    choice = answer.get("choice")
    if (not isinstance(choice, str) or not isinstance(probs, dict) or choice not in probs
            or not probs or any(not _number(v, 0, 1) for v in probs.values())):
        raise ProviderError("jev", None, "malformed_choice")
    p = float(probs[choice])
    return choice, p


def _number(value: Any, low: float, high: float) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and low <= value <= high)


def validate_answers(answers: Any, questions: dict[str, dict]) -> None:
    """Fail closed before a malformed provider/cache value becomes a privacy decision."""
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise ProviderError("jev", None, "malformed_answers")
    for key, q in questions.items():
        answer = answers[key]
        kind = q["type"]
        if not isinstance(answer, dict) or answer.get("type") != kind:
            raise ProviderError("jev", None, "malformed_answers")
        if kind == "choice":
            choice, _ = top(answer)
            if choice not in q["criteria"] or set(answer["probabilities"]) != set(q["criteria"]):
                raise ProviderError("jev", None, "malformed_choice")
        elif kind == "noul":
            if not _number(answer.get("noul"), 0, 1):
                raise ProviderError("jev", None, "malformed_noul")
        elif kind == "score":
            levels = {str(i) for i in range(len(q["criteria"]))}
            probs = answer.get("probabilities")
            if (not _number(answer.get("score"), 0, len(levels) - 1) or not isinstance(probs, dict)
                    or set(probs) != levels or any(not _number(v, 0, 1) for v in probs.values())):
                raise ProviderError("jev", None, "malformed_score")
        else:
            raise ProviderError("jev", None, "unsupported_question_type")


def tri_state(answer: dict, cutoff: float = JEV_CONFIDENCE_CUTOFF) -> tuple[str, str, float]:
    """Map a tri-state choice to (stored_choice, raw_choice, p): below the cutoff → 'unclear'."""
    raw, p = top(answer)
    return (raw if p >= cutoff else "unclear"), raw, p
