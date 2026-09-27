"""API endpoint tests: a dev-fixture snapshot in a temp data dir, fake GLM / Jev / runner."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from logless.api import app as appmod
from logless.api import leakcheck
from logless.providers import glm, jev
from programs import PANDAS_PROGRAM, STDLIB_PROGRAM, LocalRunner
from sandbox_helpers import tmp_data  # noqa: F401

REPO = Path(__file__).resolve().parents[2]
PRIVATE_MARKERS = ("conv_id", "user_id", "stderr", "dev fixture: no text", "Zyxquor")


class FakeRunner(LocalRunner):
    """Executes the submitted programs locally (the sandbox itself is tested in runner/)."""

    def health(self, timeout=1.5):
        return {"status": "ok"}


def fake_code(messages, **kw):
    """GLM stand-in for code: program A (pandas) or B (stdlib) by system prompt."""
    return f"```python\n{PANDAS_PROGRAM if 'Use pandas' in messages[0]['content'] else STDLIB_PROGRAM}\n```", {"model": "glm-5.3"}


@pytest.fixture()
def client(tmp_data, monkeypatch):
    r = subprocess.run([sys.executable, str(REPO / "backend/scripts/dev_snapshot.py"), "--data-dir", str(tmp_data), "--n", "120"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    leakcheck.reset_cache()
    fake = FakeRunner()
    monkeypatch.setattr(appmod, "_runner", fake)
    monkeypatch.setattr(appmod, "_health_cache", (0.0, "unreachable"))
    monkeypatch.setattr(appmod, "store", appmod.SnapshotStore())
    monkeypatch.setattr(appmod, "limiter", appmod.RateLimiter())
    monkeypatch.setattr(glm, "chat", fake_code)
    monkeypatch.setattr(glm, "chat_json", fake_chat_json)
    with TestClient(appmod.create_app()) as c:
        c.fake_runner = fake
        yield c
    leakcheck.reset_cache()


STORY = ("Maya is organising a weekend away with friends and wants the assistant to draft an itinerary she can share with "
         "the group [n1]. She also asks it to compare options within a budget so everyone can agree quickly [n2]. The "
         "outline arrives fast and she likes the structure. Her frustration starts with prices: the assistant has no live "
         "prices or availability, so she checks every suggestion somewhere else before she trusts it [p1]. The plan also "
         "takes several rounds of edits before it feels right, and she ends up repeating her requests [p2]. She keeps using "
         "it for outlines and comparisons, but treats every detail about cost as a guess until she has confirmed it herself.")


Q_PLAN = {"group_by": "category", "scope_category_id": None, "measure": "people", "signal": "complaint",
          "rank_by": "count", "limit": 3}


def fake_chat_json(system, user, schema, **kw):
    if schema.__name__ == "Interpretation":
        if "divorce" in user:
            return schema(unsupported="Only aggregate counts are published, not conversations."), {"model": "glm-5.3"}
        return schema.model_validate({"plan": Q_PLAN}), {"model": "glm-5.3"}
    if schema.__name__ == "_StoryOut":
        return schema(first_name="Maya", text=STORY, citations=["n1", "n2", "p1", "p2"]), {"model": "glm-5.3"}
    return schema(text="{{rows.0.id}} leads with {{rows.0.count}} of {{rows.0.base}}."), {"model": "glm-5.3"}


def wait(c, run_id, timeout=20):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        d = c.get(f"/api/runs/{run_id}").json()
        if d["state"] in ("completed", "failed"):
            return d
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def no_private(text: str):
    import re
    assert not re.search(r"\b(?:c_[0-9a-f]{12}|u_[0-9a-f]{10}|b_\d{8}T\d{6})\b", text)
    for m in PRIVATE_MARKERS:
        assert m not in text, m


def test_snapshot_health_eval(client):
    r = client.get("/api/snapshot")
    assert r.status_code == 200
    snap = r.json()
    no_private(r.text)
    assert len(snap["clusters"]) == 16 and sum(n["conversations"] for n in snap["clusters"]) == snap["totals"]["conversations"]
    h = client.get("/api/health").json()
    assert h == {"status": "ok", "sandbox": "reachable", "snapshot_id": snap["snapshot_id"]}
    e = client.get("/api/eval")
    assert e.status_code == 200 and e.json()["snapshot_id"] == snap["snapshot_id"]
    assert r.headers["cache-control"] == "no-store"


def test_usage_and_friction_are_retired(client):
    sid = client.get("/api/health").json()["snapshot_id"]
    for intent in ("usage", "friction"):
        r = client.post("/api/analyses", json={"intent": intent, "snapshot_id": sid})
        assert r.status_code == 422 and r.json()["code"] == "invalid_request"
    from logless.sandbox.runs import Run
    old = Run.create("analysis", "usage", sid)
    r = client.get(f"/api/runs/{old.id}")
    assert r.status_code == 410 and r.json()["code"] == "run_retired"


def test_containment_endpoint(client):
    rid = client.post("/api/demo/containment", json={}).json()["run_id"]
    d = wait(client, rid)
    assert d["state"] == "completed"
    assert [s["name"] for s in d["stages"]] == ["runaway", "cleanup", "health", "destructive", "followup", "leak_attempt"]
    c = d["containment"]
    assert c["killed"] and c["container_removed"] and c["app_health"] == "ok" and c["followup_passed"]
    assert c["leak_attempt_rejected"] and "Only allowlisted field names" in c["leak_rejection_checks"]
    assert c["destructive"] == {"command": "rm -rf --no-preserve-root /", "exit_code": 1, "refused": 11089, "container_removed": True,
                                "root_read_only": True, "binaries_intact": True, "next_run_clean": True, "contained": True}
    assert client.post("/api/demo/containment", json={"code": "import os"}).status_code == 422


def test_story_flow(client):
    snap = client.get("/api/snapshot").json()
    leaf = next(n for n in snap["clusters"] if n["title"] == "Planning trips and events")
    r = client.post(f"/api/clusters/{leaf['id']}/story", json={"snapshot_id": snap["snapshot_id"]}).json()
    assert r["status"] == "pending"
    d = wait(client, r["run_id"])
    assert d["state"] == "completed" and [s["name"] for s in d["stages"]] == ["writing", "checking"]
    r = client.post(f"/api/clusters/{leaf['id']}/story", json={"snapshot_id": snap["snapshot_id"]}).json()
    assert r["status"] == "ready" and r["story"]["first_name"] == "Maya" and r["story"]["citations"] == ["n1", "n2", "p1", "p2"]
    assert r["story"]["label"].startswith("Fictional user story.")
    assert client.post("/api/clusters/cl_zzzzzz/story", json={"snapshot_id": snap["snapshot_id"]}).status_code == 404


def test_search(client, monkeypatch):
    snap = client.get("/api/snapshot").json()
    target = next(n["id"] for n in snap["clusters"] if n["title"] == "Debugging code errors")
    seen = []

    def fake_ask(state, questions, use_cache=True, **kw):
        seen.append(state)
        return {q: {"choice": "relevant" if q == target else "not_relevant", "probabilities": {"relevant": 0.9 if q == target else 0.05,
                    "not_relevant": 0.05 if q == target else 0.9, "unclear": 0.05}} for q in questions}
    monkeypatch.setattr(jev, "ask", fake_ask)
    body = {"query": "fixing broken code", "snapshot_id": snap["snapshot_id"]}
    r = client.post("/api/search", json=body).json()
    assert r["results"][0] == {"cluster_id": target, "relevance": "relevant", "p": 0.9}
    assert len(r["results"]) == 16 and isinstance(r["elapsed_ms"], int)
    client.post("/api/search", json={**body, "query": "  FIXING broken   code "})
    assert len(seen) == 1  # cached per normalized query
    assert set(seen[0]["clusters"][target]) == {"title", "description"}   # only public fields reach Jev
    assert client.post("/api/search", json={**body, "query": "x" * 201}).status_code == 422


def test_errors_are_code_message_only(client):
    sid = client.get("/api/health").json()["snapshot_id"]
    cases = [
        client.post("/api/analyses", json={"intent": "drop tables", "snapshot_id": sid}),
        client.post("/api/analyses", json={"intent": "question", "question": "q", "snapshot_id": "snap_20200101T000000_ffff"}),
        client.get("/api/runs/run_000000000000"),
        client.get("/api/runs/../../etc/passwd"),
        client.post("/api/search", content=b"{" * 9000, headers={"Content-Type": "application/json"}),
        client.post("/api/analyses", content=b"not json", headers={"Content-Type": "application/json"}),
    ]
    assert [r.status_code for r in cases] == [422, 409, 404, 404, 413, 422]
    for r in cases:
        body = r.json()
        assert set(body) == {"code", "message"}, body
        assert "Traceback" not in r.text and "drop tables" not in r.text


def test_rate_limit(client):
    codes = [client.post("/api/demo/containment", json={}).status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and codes[-1] == 429
    assert client.post("/api/demo/containment", json={}).json()["code"] == "rate_limited"


def test_eval_404_shape(client, monkeypatch):
    from logless import db
    con = db.public()
    with db.write(con):
        con.execute("DELETE FROM eval_reports")
    r = client.get("/api/eval")
    assert r.status_code == 404 and r.json()["code"] == "no_eval_report" and r.json()["checks"] == []


# ---------------------------------------------------------------- hardening: budgets, coalescing, bookkeeping

def _snap(client):
    return client.get("/api/snapshot").json()


def _slow_ask(counter, delay):
    def fake_ask(state, questions, use_cache=True, **kw):
        with counter["lock"]:
            counter["n"] += 1
        time.sleep(delay)
        return {q: {"choice": "not_relevant", "probabilities": {"relevant": 0.05, "not_relevant": 0.9, "unclear": 0.05}}
                for q in questions}
    return fake_ask


def test_budget_exhausted(client, monkeypatch):
    import threading
    from logless.api.ratelimit import HourlyBudget
    monkeypatch.setattr(appmod, "budget", HourlyBudget({"search": 1, "analysis": 1, "story": 1, "containment": 1}))
    counter = {"n": 0, "lock": threading.Lock()}
    monkeypatch.setattr(jev, "ask", _slow_ask(counter, 0))
    sid = _snap(client)["snapshot_id"]
    assert client.post("/api/search", json={"query": "email", "snapshot_id": sid}).status_code == 200
    assert client.post("/api/search", json={"query": " EMAIL ", "snapshot_id": sid}).status_code == 200  # cached: free
    r = client.post("/api/search", json={"query": "travel", "snapshot_id": sid})
    assert r.status_code == 429 and r.json()["code"] == "budget_exhausted" and int(r.headers["retry-after"]) > 0
    assert "hourly budget for searches" in r.json()["message"] and counter["n"] == 1
    rid = client.post("/api/analyses", json={"intent": "question", "question": "a", "snapshot_id": sid}).json()["run_id"]
    wait(client, rid)
    r = client.post("/api/analyses", json={"intent": "question", "question": "b", "snapshot_id": sid})
    assert r.status_code == 429 and r.json()["code"] == "budget_exhausted"


def test_identical_searches_coalesce_and_health_stays_responsive(client, monkeypatch):
    import threading
    from logless.api.ratelimit import LIMITS, RateLimiter
    monkeypatch.setattr(appmod, "limiter", RateLimiter({**LIMITS, "search": (50, 10.0)}))  # one test IP
    counter = {"n": 0, "lock": threading.Lock()}
    monkeypatch.setattr(jev, "ask", _slow_ask(counter, 1.0))
    sid = _snap(client)["snapshot_id"]
    codes: list[int] = []

    def go(q):
        codes.append(client.post("/api/search", json={"query": q, "snapshot_id": sid}).status_code)
    threads = [threading.Thread(target=go, args=("same question",)) for _ in range(5)]
    threads += [threading.Thread(target=go, args=(f"other question {i}",)) for i in range(4)]
    for t in threads:
        t.start()
    time.sleep(0.3)
    t0 = time.monotonic()
    assert client.get("/api/health").status_code == 200       # not starved by slow searches
    assert time.monotonic() - t0 < 0.5
    for t in threads:
        t.join(10)
    assert codes.count(200) == 9
    assert counter["n"] == 5          # 5 identical requests shared one Jev call; 4 distinct ones had their own


def test_story_inflight_entry_only_released_by_its_own_run(client, monkeypatch):
    import threading
    gate_ev = threading.Event()

    def slow_story(system, user, schema, **kw):
        gate_ev.wait(5)
        return fake_chat_json(system, user, schema, **kw)
    monkeypatch.setattr(glm, "chat_json", slow_story)
    snap = _snap(client)
    leaf = next(n for n in snap["clusters"] if n["title"] == "Planning trips and events")
    r1 = client.post(f"/api/clusters/{leaf['id']}/story", json={"snapshot_id": snap["snapshot_id"]}).json()
    r2 = client.post(f"/api/clusters/{leaf['id']}/story", json={"snapshot_id": snap["snapshot_id"]}).json()
    assert r1["status"] == r2["status"] == "pending" and r1["run_id"] == r2["run_id"]   # coalesced
    key = (snap["snapshot_id"], leaf["id"])
    appmod._story_inflight[key] = "run_ffffffffffff"   # a newer run took over the key
    gate_ev.set()
    wait(client, r1["run_id"])
    time.sleep(0.1)
    assert appmod._story_inflight.get(key) == "run_ffffffffffff"   # not dropped by the older run
    appmod._story_inflight.pop(key, None)
    assert client.post(f"/api/clusters/{leaf['id']}/story", json={"snapshot_id": snap["snapshot_id"]}).json()["status"] == "ready"


def test_snapshot_serves_short_title(client):
    snap = _snap(client)
    for n in snap["categories"] + snap["clusters"]:
        assert 0 < len(n["short_title"]) <= 24



# ---------------------------------------------------------------- open questions + presenter

def test_question_via_api(client, monkeypatch):
    from logless.api.ratelimit import LIMITS, RateLimiter
    monkeypatch.setattr(appmod, "limiter", RateLimiter({**LIMITS, "analysis": (50, 10.0)}))  # one test IP
    sid = _snap(client)["snapshot_id"]
    body = {"intent": "question", "question": "Which categories have the most complaints?", "snapshot_id": sid}
    r1 = client.post("/api/analyses", json=body).json()
    r2 = client.post("/api/analyses", json={**body, "question": "  which CATEGORIES have the most complaints? "}).json()
    d = wait(client, r1["run_id"])
    assert r2["run_id"] == r1["run_id"] or d["state"] in ("completed", "failed")
    assert d["state"] == "completed", d["error"]
    assert d["intent"] == "question" and d["plan"] == Q_PLAN and d["question"] == body["question"]
    assert d["result"]["plan"] == Q_PLAN and len(d["result"]["rows"]) == 3
    assert all(r["id"].startswith("cat_") for r in d["result"]["rows"])
    assert [(a["attempt"], a["program"]) for a in d["attempts_log"]] == [(1, "A"), (1, "B")]
    assert d["attempts_log"][0]["receipt"]["runtime"] == "runsc" and d["verdict"]["checks"][-1]["name"] == "Two independent programs agree"
    assert "Consistent with the published map · base = published people" in [c["name"] for c in d["verdict"]["checks"]]
    no_private(json.dumps(d))
    assert d["stages"][0]["name"] == "interpreting"
    other = client.post("/api/analyses", json={**body, "question": "Show me the conversations about divorce"}).json()
    assert other["run_id"] != r1["run_id"]
    d2 = wait(client, other["run_id"])
    assert d2["state"] == "failed" and d2["error"]["code"] == "unsupported_question" and d2["attempts_log"] == []
    assert client.post("/api/analyses", json={"intent": "question", "snapshot_id": sid}).status_code == 422
    assert client.post("/api/analyses", json={**body, "question": "x" * 201}).status_code == 422


def test_presenter_capacity(client, monkeypatch):
    import threading
    from logless.api.ratelimit import HourlyBudget
    monkeypatch.setenv("PRESENTER_KEY", "stage-key-123")
    monkeypatch.setattr(appmod, "budget", HourlyBudget({"search": 0, "analysis": 0, "story": 0, "containment": 0}))
    monkeypatch.setattr(appmod, "presenter_budget", HourlyBudget({"search": 50, "analysis": 50, "story": 50, "containment": 1}))
    counter = {"n": 0, "lock": threading.Lock()}
    monkeypatch.setattr(jev, "ask", _slow_ask(counter, 0))
    sid = _snap(client)["snapshot_id"]
    good, wrong = {"X-Logless-Presenter": "stage-key-123"}, {"X-Logless-Presenter": "guess"}
    q = {"query": "email", "snapshot_id": sid}
    assert client.post("/api/search", json=q).status_code == 429                      # public budget empty
    assert client.post("/api/search", json=q, headers=wrong).status_code == 429       # wrong key = public
    assert client.post("/api/search", json=q, headers=good).status_code == 200       # presenter budget
    # the presenter skips per-IP buckets: many searches in a row still pass
    for i in range(12):
        assert client.post("/api/search", json={**q, "query": f"q{i}"}, headers=good).status_code == 200
    assert client.post("/api/demo/containment", json={}, headers=good).status_code == 200
    r = client.post("/api/demo/containment", json={}, headers=good)
    assert r.status_code == 200   # in flight: same run, no new budget
    monkeypatch.delenv("PRESENTER_KEY")
    assert client.post("/api/search", json={**q, "query": "new"}, headers=good).status_code == 429   # feature off
