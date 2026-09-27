"""PRD validator: numbers only through placeholders, evidence ids from the cluster, story shape."""
from __future__ import annotations

from logless.api.prds import _PrdOut, placeholder_values, priority, validate

NODE = {
    "id": "cl_aaaaaa", "level": 2, "parent_id": "cat_111111", "title": "Debugging code", "description": "d",
    "conversations": 1234, "users": 800, "share": 0.1,
    "friction": {"conversations": 400, "share": 0.3241, "signals": {"correction": 120, "repeat_request": 200,
                                                                  "assistant_limit": 50, "complaint": 30}},
    "needs": [{"id": "n1", "text": "Fix errors"}, {"id": "n2", "text": "Explain code"}],
    "problems": [{"id": "p1", "text": "Wrong fixes", "signal": "correction", "support": "common"}],
}
GOOD = {
    "title": "Verified fixes for code errors",
    "problem": "People bring errors to fix [n1] but get wrong fixes they must correct [p1]. {friction_share} show friction.",
    "user_stories": ["As a developer, I want a fix that runs so that I stop retrying [n1] [p1].",
                     "As a learner, I want the fix explained so that I understand it [n2]."],
    "requirements": ["Run suggested fixes before replying [p1].", "Explain each change [n2].", "Ask for the full error [n1]."],
    "success_metrics": ["Corrections fall below {correction}.", "Friction share drops from {friction_share}."],
}


def test_good_draft_is_filled_with_published_numbers():
    probs, out = validate(_PrdOut(**GOOD), NODE)
    assert probs == []
    assert "32.4% show friction" in out["problem"] and out["success_metrics"][0] == "Corrections fall below 120."
    assert out["citations"] == ["n1", "p1", "n2"]
    assert placeholder_values(NODE)["conversations"] == "1,234"


def test_model_digits_unknown_ids_and_placeholders_rejected():
    bad = dict(GOOD, problem="Thirty users [p9] see 32% friction {secret}.",
               user_stories=["Users want fixes [n1].", GOOD["user_stories"][1]],
               success_metrics=["Fewer corrections.", "Friction share drops from {friction_share}."])
    probs, _ = validate(_PrdOut(**bad), NODE)
    text = " | ".join(probs)
    assert "no digits" in text and "p9" in text and "{secret}" in text
    assert "user_stories[1]" in text and "success_metrics[1]" in text


def test_priority_from_published_counts():
    others = [dict(NODE, id=f"cl_{i:06d}", friction={"conversations": 1000 - i}) for i in range(6)]
    clusters = [{"id": "cat_111111", "level": 1}, NODE, *others]
    p = priority(NODE, clusters)
    assert p["rank"] == 7 and p["of"] == 7 and p["level"] == "P1"
    assert priority(dict(NODE, id="cl_other"), clusters)["level"] is None


def test_grouped_citations_are_split():
    good = dict(GOOD, requirements=["Run suggested fixes before replying [n1, p1].", *GOOD["requirements"][1:]])
    probs, out = validate(_PrdOut(**good), NODE)
    assert probs == [] and out["requirements"][0] == "Run suggested fixes before replying [n1] [p1]."
