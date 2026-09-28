"""The closed Plan vocabulary for open questions (docs/CONTRACTS.md §8b).

A question is only ever answered through a validated Plan: a handful of enumerated choices over
published ids. Nothing in a Plan can name a person, a conversation or a free-text field, so the
interpreting model cannot ask for anything the aggregates don't already allow."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Signal = Literal["any_friction", "correction", "repeat_request", "assistant_limit", "complaint"]
PLAN_KEYS = ("group_by", "scope_category_id", "scope_leaf_id", "measure", "signal", "rank_by", "limit")
PLAN_STRINGS = {"leaf", "category", "subtheme", "conversations", "people", "count", "share",
                "any_friction", "correction", "repeat_request", "assistant_limit", "complaint"}


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    group_by: Literal["leaf", "category", "subtheme"]
    scope_category_id: str | None = Field(default=None, pattern=r"^cat_[0-9a-f]{6}$")
    scope_leaf_id: str | None = Field(default=None, pattern=r"^cl_[0-9a-f]{6}$")
    measure: Literal["conversations", "people"]
    signal: Signal | None = None
    rank_by: Literal["count", "share"]
    limit: int = Field(ge=1, le=10)

    @model_validator(mode="after")
    def _scope_needs_finer_groups(self) -> "Plan":
        if self.scope_category_id is not None and self.group_by == "category":
            raise ValueError("scope_category_id requires group_by 'leaf' or 'subtheme'")
        if self.scope_leaf_id is not None and self.group_by != "subtheme":
            raise ValueError("scope_leaf_id requires group_by 'subtheme'")
        if self.scope_category_id is not None and self.scope_leaf_id is not None:
            raise ValueError("set at most one of scope_category_id and scope_leaf_id")
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


def question_scope(clusters: list[dict], plan: dict) -> tuple[list[str], set[str]]:
    """(group ids in scope, leaf ids in scope) — structure only, no data. Other or unclear (any
    is_other leaf, cl_other, anything in an is_other category) is never in scope. With group_by
    "subtheme" the groups are the level-3 sub-themes of those leaves minus each leaf's remainder
    (is_other), and only rows in one of the groups are in scope."""
    cats = {c["id"]: c for c in clusters if int(c["level"]) == 1}
    other_cats = {cid for cid, c in cats.items() if c.get("is_other")}
    leaves = [c for c in clusters if int(c["level"]) == 2 and not c.get("is_other") and c["id"] != "cl_other"
              and c.get("parent_id") not in other_cats]
    scope = plan.get("scope_category_id")
    if scope is not None:
        leaves = [c for c in leaves if c["parent_id"] == scope]
    if plan.get("scope_leaf_id") is not None:
        leaves = [c for c in leaves if c["id"] == plan["scope_leaf_id"]]
    leaf_ids = {c["id"] for c in leaves}
    if plan["group_by"] == "leaf":
        groups = sorted(leaf_ids)
    elif plan["group_by"] == "subtheme":
        groups = sorted(c["id"] for c in clusters if int(c["level"]) == 3 and not c.get("is_other")
                        and c.get("parent_id") in leaf_ids)
    else:
        groups = sorted({c["parent_id"] for c in leaves})
    return groups, leaf_ids


def semantic_problems(plan: Plan, clusters: list[dict]) -> list[str]:
    """Checks that need the snapshot: a scope must be a published, non-Other category or workflow
    with groups in it."""
    cats = {c["id"]: c for c in clusters if int(c["level"]) == 1}
    leaves = {c["id"]: c for c in clusters if int(c["level"]) == 2}
    problems = []
    if plan.scope_category_id is not None:
        c = cats.get(plan.scope_category_id)
        if c is None:
            problems.append("scope_category_id is not a published category")
        elif c.get("is_other"):
            problems.append("scope_category_id cannot be the Other category")
    if plan.scope_leaf_id is not None:
        c = leaves.get(plan.scope_leaf_id)
        if c is None:
            problems.append("scope_leaf_id is not a published workflow")
        elif c.get("is_other") or cats.get(c.get("parent_id"), {}).get("is_other"):
            problems.append("scope_leaf_id cannot be an Other workflow")
        elif not any(int(x["level"]) == 3 and x.get("parent_id") == c["id"] for x in clusters):
            problems.append("that workflow has no sub-themes; use group_by 'leaf' or answer unsupported")
    if plan.group_by == "subtheme" and not any(int(c["level"]) == 3 for c in clusters):
        problems.append("this snapshot has no sub-themes; use group_by 'leaf' or 'category'")
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
    by = {"leaf": "by workflow", "category": "by category", "subtheme": "by sub-theme"}
    parts = ["Distinct people" if plan["measure"] == "people" else "Conversations"]
    if plan.get("signal"):
        parts.append(SIGNAL_WORDS[plan["signal"]])
    for key in ("scope_category_id", "scope_leaf_id"):
        if plan.get(key):
            parts.append(f"within {titles.get(plan[key], plan[key])}")
    parts.append(by[plan["group_by"]])
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
