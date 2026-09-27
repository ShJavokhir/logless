"""Runner HTTP API tests (fake docker)."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from logless_runner import config
from logless_runner.app import BodyLimit, create_app
from logless_runner.supervisor import Supervisor

from .fakes import Behavior, FakeDocker, frame

TOKEN = "test-token-123"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    s = config.Settings(token=TOKEN, bind="127.0.0.1:0", runtime="runsc", image="logless-analysis:1", image_digest="",
                        work_dir=tmp_path / "jobs", concurrency=1, result_ttl_s=900, docker_bin="docker",
                        tmp_tmpfs=config.TMP_TMPFS, out_tmpfs=config.OUT_TMPFS)
    fake = FakeDocker(behavior=Behavior(stdout=frame(b'{"ok": true}')))
    sup = Supervisor(s, docker=fake)
    with TestClient(create_app(s, sup)) as c:
        yield c
    sup.stop()


def job(**kw):
    d = {"job_id": str(uuid.uuid4()), "kind": "analysis", "code": "print(1)\n",
         "files": {"assignments.csv": "row\n1\n"}, "timeout_s": 5, "memory_mb": 512}
    d.update(kw)
    return d


def test_requires_token(client):
    assert client.post("/jobs", json=job()).status_code == 401
    assert client.post("/jobs", json=job(), headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get(f"/jobs/{uuid.uuid4()}").status_code == 401
    # auth is checked before the body is validated
    r = client.post("/jobs", json={})
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"


def test_health_is_open_and_has_no_config(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["runtime"] == "runsc" and body["docker"] == "29.0.0"
    assert TOKEN not in r.text


def test_submit_poll_idempotent(client):
    j = job()
    r = client.post("/jobs", json=j, headers=AUTH)
    assert r.status_code == 202 and r.json()["job_id"] == j["job_id"]
    r2 = client.post("/jobs", json=j, headers=AUTH)
    assert r2.status_code == 202
    deadline = time.monotonic() + 5
    while True:
        v = client.get(f"/jobs/{j['job_id']}", headers=AUTH).json()
        if v["state"] in ("succeeded", "failed", "timed_out") or time.monotonic() > deadline:
            break
        time.sleep(0.02)
    assert v["state"] == "succeeded" and v["output"] == '{"ok": true}' and v["container_removed"] is True
    assert client.post("/jobs", json={**j, "code": "print(2)\n"}, headers=AUTH).status_code == 409


@pytest.mark.parametrize("bad", [
    {"job_id": "not-a-uuid"},
    {"kind": "shell"},
    {"code": "x" * (64 * 1024 + 1)},
    {"files": {"../etc/passwd": "x"}},
    {"files": {"main.py": "x"}},
    {"files": {"notes.txt": "x"}},
    {"timeout_s": 11},
    {"timeout_s": 0},
    {"timeout_s": True},
    {"timeout_s": "5"},
    {"memory_mb": 4096},
    {"extra": 1},
])
def test_validation(client, bad):
    r = client.post("/jobs", json=job(**bad), headers=AUTH)
    assert r.status_code == 422
    body = r.json()
    assert set(body) == {"code", "message"}
    assert "etc/passwd" not in body["message"]


def test_files_total_cap(client):
    big = "x" * (4 * 1024 * 1024 + 1)
    r = client.post("/jobs", json=job(files={"assignments.csv": big, "clusters.json": big}), headers=AUTH)
    assert r.status_code == 422


def test_body_limit(client):
    r = client.post("/jobs", content=b"x" * (config.MAX_REQUEST_BYTES + 1), headers={**AUTH, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_streamed_body_limit(client):
    def chunks():
        for _ in range(12):
            yield b"x" * (1024 * 1024)   # no Content-Length: chunked
    r = client.post("/jobs", content=chunks(), headers={**AUTH, "Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["code"] == "payload_too_large"


def test_oversized_stream_with_valid_json_prefix_never_reaches_endpoint():
    """Previously the last chunk was dropped, so valid earlier JSON could queue a job behind 413."""
    called, sent = [], []
    prefix = json.dumps(job()).encode()
    chunks = iter([
        {"type": "http.request", "body": prefix, "more_body": True},
        {"type": "http.request", "body": b" " * 1000, "more_body": False},
    ])

    async def receive():
        return next(chunks)

    async def send(message):
        sent.append(message)

    async def endpoint(scope, receive, send):
        called.append(True)

    asyncio.run(BodyLimit(endpoint, len(prefix) + 10)({"type": "http", "headers": []}, receive, send))
    assert not called
    assert sent[0]["status"] == 413


@pytest.mark.parametrize("bad", [{"private-email@example.com": "secret"}, {"files": {"private-name": 1}}, {"code": "\ud800"}])
def test_validation_does_not_echo_unknown_fields_or_unicode_fragments(client, bad):
    raw = json.dumps(job(**bad)).encode()
    response = client.post("/jobs", content=raw, headers={**AUTH, "Content-Type": "application/json"})
    assert response.status_code == 422
    assert "private-" not in response.text and "surrogates" not in response.text


def test_auth_checked_before_body(client):
    # Unauthenticated requests are refused on headers alone, whatever the body.
    r = client.post("/jobs", content=b"x" * (config.MAX_REQUEST_BYTES + 1), headers={"Content-Type": "application/json"})
    assert r.status_code == 401
    r = client.post("/jobs", content=b"not json", headers={"Content-Type": "application/json", "Authorization": "Bearer nope"})
    assert r.status_code == 401 and r.json() == {"code": "unauthorized", "message": "missing or invalid bearer token"}


def test_quarantine_returns_503(client):
    sup = client.app.app.app.state.supervisor if hasattr(client.app, "app") else None
    sup.quarantine["j"] = "c"
    try:
        r = client.post("/jobs", json=job(), headers=AUTH)
        assert r.status_code == 503 and r.json()["code"] == "quarantined"
        assert client.get("/health").json()["status"] == "degraded"
    finally:
        sup.quarantine.clear()


def test_unknown_job(client):
    assert client.get(f"/jobs/{uuid.uuid4()}", headers=AUTH).status_code == 404
    assert client.get("/jobs/abc", headers=AUTH).status_code == 404


def test_stopping_runner_refuses_new_jobs_without_creating_records(client):
    sup = client.app.app.app.state.supervisor
    sup.stop()
    submitted = job()
    response = client.post("/jobs", json=submitted, headers=AUTH)
    assert response.status_code == 503 and response.json()["code"] == "stopping"
    assert sup.get(submitted["job_id"]) is None
    assert client.get("/health").json()["status"] == "degraded"


def test_refuses_without_token(tmp_path):
    s = config.Settings(token="", bind="127.0.0.1:0", runtime="runsc", image="x", image_digest="", work_dir=tmp_path,
                        concurrency=1, result_ttl_s=1, docker_bin="docker", tmp_tmpfs="", out_tmpfs="")
    with pytest.raises(RuntimeError):
        create_app(s, Supervisor(s, docker=FakeDocker()))
