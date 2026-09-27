"""Composition cannot change the checked answer or add executable capabilities."""
import copy
import json
from pathlib import Path

import pytest

from logless.api import canvas
from logless.providers import jev
from logless.providers.http import ProviderError


@pytest.fixture
def content():
    snapshot = json.loads((Path(__file__).resolve().parents[2] / "web/src/mocks/real-snapshot.json").read_text())
    node = next(n for n in snapshot["clusters"] if n.get("needs"))
    run = {"run_id": "run_123456abcdef", "question": "What do users need?", "result": {
        "plan": {"measure": "conversations", "signal": None}, "rows": [{"id": node["id"]}],
    }}
    return snapshot, run


def answer(questions, placements):
    return {key: {"type": "choice", "choice": placements.get(key, "omit"),
                  "probabilities": {option: float(option == placements.get(key, "omit")) for option in q["criteria"]}}
            for key, q in questions.items()}


def test_jev_composes_order_without_controlling_data(content, monkeypatch):
    snapshot, run = content
    before = copy.deepcopy(content)
    def choose(state, questions, **kw):
        assert "rows" not in state and "code" not in state
        assert set(state["workflows"][0]) == {"title", "description"}
        assert kw["timeout"] == 8 and kw["attempts"] == 1
        return answer(questions, {"intent": "presentation", "needs": "lead", "ranking": "support"})
    monkeypatch.setattr(jev, "ask", choose)
    result = canvas.compose(snapshot, run, "Put needs first", ["ranking"])
    assert result["status"] == "composed"
    assert result["selected"] == ["needs", "ranking"]
    assert result["spec"]["elements"]["canvas"]["children"] == ["needs", "ranking"]
    assert all(not e["props"] for e in result["spec"]["elements"].values())
    assert content == before


@pytest.mark.parametrize("failure", ["timeout", "malformed", "empty"])
def test_failure_preserves_previous_view(content, monkeypatch, failure):
    def choose(state, questions, **kw):
        if failure == "timeout":
            raise ProviderError("jev", None, "ReadTimeout")
        if failure == "malformed":
            return {"ranking": {"type": "choice", "choice": "<script>"}}
        return answer(questions, {"intent": "presentation"})
    monkeypatch.setattr(jev, "ask", choose)
    result = canvas.compose(*content, "Change the view", ["cards", "ranking"])
    assert result["status"] == "fallback"
    assert result["selected"] == ["cards", "ranking"]


def test_new_analysis_is_not_represented_as_a_layout_edit(content, monkeypatch):
    monkeypatch.setattr(jev, "ask", lambda state, questions, **kw: answer(questions, {"intent": "analysis"}))
    result = canvas.compose(*content, "Only health, last week", ["ranking"])
    assert result["status"] == "needs_analysis"
    assert result["selected"] == ["ranking"]


def test_missing_data_excludes_candidates(content):
    snapshot, run = content
    run["result"]["rows"] = []
    assert canvas.eligible(snapshot, run["result"]) == ["ranking"]


def test_api_requires_checked_current_answer(client, monkeypatch):
    from logless.api import app as appmod
    from logless.sandbox.runs import Run
    snapshot = client.get("/api/snapshot").json()
    run = Run.create("analysis", "question", snapshot["snapshot_id"], question="What is common?")
    body = {"snapshot_id": snapshot["snapshot_id"], "run_id": run.id}
    def unexpected(*args, **kwargs):
        pytest.fail("Unverified inputs reached Jev")
    monkeypatch.setattr(jev, "ask", unexpected)
    assert client.post("/api/canvas", json=body).json()["code"] == "unverified_result"
    assert client.post("/api/canvas", json={**body, "snapshot_id": "old"}).json()["code"] == "stale_snapshot"
    assert client.post("/api/canvas", json={**body, "spec": {}}).status_code == 422
    assert client.post("/api/canvas", json={**body, "previous": ["script"]}).status_code == 422
    assert appmod.bucket_for("POST", "/api/canvas") == "canvas"


def test_api_composes_after_actual_analysis_gate(client, monkeypatch):
    from test_api_app import wait
    snapshot = client.get("/api/snapshot").json()
    started = client.post("/api/analyses", json={"intent": "question", "snapshot_id": snapshot["snapshot_id"],
                                               "question": "Which categories have the most complaints?"}).json()
    run = wait(client, started["run_id"])
    assert run["state"] == "completed"
    monkeypatch.setattr(jev, "ask", lambda state, questions, **kw: answer(questions, {"intent": "presentation", "signals": "lead"}))
    response = client.post("/api/canvas", json={"snapshot_id": snapshot["snapshot_id"], "run_id": run["run_id"]})
    assert response.status_code == 200
    assert response.json()["selected"] == ["signals"]
    assert client.get(f"/api/runs/{run['run_id']}").json()["result"] == run["result"]


# Reuse the real API fixture, with isolated databases and fake upstream providers.
from test_api_app import client  # noqa: E402, F401
from sandbox_helpers import tmp_data  # noqa: E402, F401
