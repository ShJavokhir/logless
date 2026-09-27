"""The closed Plan vocabulary for open questions (docs/CONTRACTS.md §8b).

A question is only ever answered through a validated Plan: a handful of enumerated choices over
published ids. Nothing in a Plan can name a person, a conversation or a free-text field, so the
interpreting model cannot ask for anything the aggregates don't already allow."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Signal = Literal["any_friction", "correction", "repeat_request", "assistant_limit", "complaint"]
PLAN_KEYS = ("group_by", "scope_category_id", "measure", "signal", "rank_by", "limit")
PLAN_STRINGS = {"leaf", "category", "conversations", "people", "count", "share",
                "any_friction", "correction", "repeat_request", "assistant_limit", "complaint"}


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    group_by: Literal["leaf", "category"]
    scope_category_id: str | None = Field(default=None, pattern=r"^cat_[0-9a-f]{6}$")
    measure: Literal["conversations", "people"]
    signal: Signal | None = None
    rank_by: Literal["count", "share"]
    limit: int = Field(ge=1, le=10)

    @model_validator(mode="after")
    def _scope_needs_leaves(self) -> "Plan":
        if self.scope_category_id is not None and self.group_by != "leaf":
            raise ValueError("scope_category_id requires group_by 'leaf'")
        return self


class Interpretation(BaseModel):
    """What the interpreting model returns: exactly one of a plan or a short unsupported reason."""
    model_config = ConfigDict(extra="forbid")
    plan: Plan | None = None
    unsupported: str | None = Field(default=None, max_length=400)

    @model_validator(mode="after")
    def _exactly_one(self) -> "Interpretation":
        if (self.plan is None) == (self.unsupported is None):
            raise ValueError("return exactly one of 'plan' or 'unsupported'")
        return self


def semantic_problems(plan: Plan, clusters: list[dict]) -> list[str]:
    """Checks that need the snapshot: the scope must be a published, non-Other category with leaves."""
    from .reference import question_scope
    cats = {c["id"]: c for c in clusters if int(c["level"]) == 1}
    problems = []
    if plan.scope_category_id is not None:
        c = cats.get(plan.scope_category_id)
        if c is None:
            problems.append("scope_category_id is not a published category")
        elif c.get("is_other"):
            problems.append("scope_category_id cannot be the Other category")
    if not problems and not question_scope(clusters, plan.model_dump())[0]:
        problems.append("the plan's scope contains no groups")
    return problems


SIGNAL_WORDS = {
    None: None, "any_friction": "with any observed friction", "correction": "with corrections",
    "repeat_request": "with repeated requests", "assistant_limit": "hitting assistant limits", "complaint": "with complaints",
}


def plan_text(plan: dict, titles: dict[str, str]) -> str:
    """The plan in words, e.g. "Distinct people · with repeated requests · within Build software ·
    by workflow · top 5 by count" (used in prompts after interpretation and in stage details)."""
    parts = ["Distinct people" if plan["measure"] == "people" else "Conversations"]
    if plan.get("signal"):
        parts.append(SIGNAL_WORDS[plan["signal"]])
    if plan.get("scope_category_id"):
        parts.append(f"within {titles.get(plan['scope_category_id'], plan['scope_category_id'])}")
    parts.append("by workflow" if plan["group_by"] == "leaf" else "by category")
    rank = "count" if plan["rank_by"] == "count" else "share (count ÷ same measure without the filter)"
    parts.append(f"top {plan['limit']} by {rank}")
    return " · ".join(parts)


# ---------------------------------------------------------------- question text hygiene

_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁦-⁩]")


def normalize_question(q: str) -> str:
    return " ".join(_CTRL.sub(" ", q).lower().split())


def sanitize_question(q: str) -> str:
    """The echo stored in Run.question (public): control characters removed, whitespace collapsed,
    ≤ 200 chars, and emails / URLs / phone numbers / private ids / canary tokens replaced."""
    from ..api import leakcheck
    text = " ".join(_CTRL.sub(" ", q).split())[:200]
    for pat in (leakcheck.EMAIL, leakcheck.URL, leakcheck.PRIVATE_ID, leakcheck.PHONE):
        text = pat.sub("[removed]", text)
    low = text.lower()
    for tok in leakcheck.canary_tokens():
        start = low.find(tok)
        while start >= 0:
            text = text[:start] + "[removed]" + text[start + len(tok):]
            low = text.lower()
            start = low.find(tok)
    return text


UNSUPPORTED_FALLBACK = "This question can't be answered from the published aggregate counts."


def clean_unsupported_reason(reason: str, allowed_ids: set[str]) -> str:
    """The model's short reason if it passes validation, else a fixed sentence."""
    from ..api import leakcheck
    text = " ".join(_CTRL.sub(" ", reason or "").split())
    if not text or len(text) > 160:
        return UNSUPPORTED_FALLBACK
    stripped = text
    for i in sorted(allowed_ids, key=len, reverse=True):
        stripped = stripped.replace(i, "")
    if re.search(r"\d", stripped) or leakcheck.problems(text) or "{" in text or "<" in text:
        return UNSUPPORTED_FALLBACK
    return text
