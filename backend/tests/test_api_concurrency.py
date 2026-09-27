"""Bounded contention experiment for the documented public/presenter admission contract.

Uses real FastAPI requests through TestClient and blocked test workers, not live providers.
This checks coordination under contention, not deployed HTTP throughput or model latency.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from logless.api import app as api
from logless.api.ratelimit import HourlyBudget, LIMITS, RateLimiter
from test_api_app import client  # noqa: F401 — isolated snapshot, fake providers and runner


def test_public_contention_preserves_presenter_capacity_polling_and_coalescing(client, monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(api, "limiter", RateLimiter({**LIMITS, "analysis": (100, 100.0)}))
    monkeypatch.setattr(api, "budget", HourlyBudget({"analysis": 100}))
    monkeypatch.setattr(api, "presenter_budget", HourlyBudget({"analysis": 100}))
    monkeypatch.setenv("PRESENTER_KEY", "synthetic-stage-key")
    sid = client.get("/api/snapshot").json()["snapshot_id"]

    def blocked(run, **kwargs):
        run.state("executing")
        release.wait(10)
        run.fail("simulation_finished", "The isolated contention simulation ended.")

    monkeypatch.setattr(api, "run_analysis", blocked)
    ids = []

    def ask(i, presenter=False):
        body = {"intent": "question", "snapshot_id": sid, "question": f"Test aggregate request {i}"}
        headers = {"X-Logless-Presenter": "synthetic-stage-key"} if presenter else {}
        return i, client.post("/api/analyses", json=body, headers=headers)

    try:
        with ThreadPoolExecutor(max_workers=12) as callers:
            replies = list(callers.map(ask, range(12)))
        accepted = [(i, r.json()["run_id"]) for i, r in replies if r.status_code == 200]
        ids.extend(rid for _, rid in accepted)
        assert len(accepted) == 4
        assert [r.json()["code"] for _, r in replies if r.status_code != 200] == ["busy"] * 8
        # A retry joins existing work even while new public work has no capacity.
        repeated = ask(accepted[0][0])[1]
        assert repeated.json()["run_id"] == accepted[0][1]
        assert api.budget.remaining("analysis") == 96
        reserved = [ask(i, True)[1] for i in (20, 21, 22)]
        ids.extend(r.json()["run_id"] for r in reserved if r.status_code == 200)
        assert [r.status_code for r in reserved] == [200, 200, 429]
        assert reserved[-1].json()["code"] == "busy"
        assert client.get("/api/health").json()["status"] == "ok"
        assert all(client.get(f"/api/runs/{rid}").json()["state"] in ("queued", "executing") for rid in ids)
    finally:
        release.set()
        deadline = time.monotonic() + 5
        while api._active and time.monotonic() < deadline:
            time.sleep(0.01)
    assert api._active == 0
    assert all(client.get(f"/api/runs/{rid}").json()["state"] == "failed" for rid in ids)
