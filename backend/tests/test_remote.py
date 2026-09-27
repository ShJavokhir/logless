"""Remote pairing protects the session token and cleans up its NetBird URL."""
from __future__ import annotations

import time

import httpx
import pytest
from fastapi.testclient import TestClient

from logless.api import app as api
from logless.api import remote
from logless import netbird

PRESENTER = {"X-Logless-Presenter": "remote-test-key"}


@pytest.fixture()
def client(tmp_data, monkeypatch):
    monkeypatch.setenv("PRESENTER_KEY", PRESENTER["X-Logless-Presenter"])
    monkeypatch.setenv("LOGLESS_ENV", "development")
    monkeypatch.setattr(netbird, "configured", lambda: False)
    monkeypatch.setattr(remote, "_nb", None)
    monkeypatch.setattr(api, "limiter", api.RateLimiter())
    remote._sessions.clear()
    with TestClient(api.create_app()) as test_client:
        yield test_client
    remote._sessions.clear()


def test_pairing_token_and_endpoints(client, monkeypatch):
    assert client.post("/api/remote/sessions").status_code == 403
    created = client.post("/api/remote/sessions", headers=PRESENTER)
    assert created.status_code == 201
    session = created.json()
    sid, token = session["session_id"], session["token"]
    path = f"/api/remote/sessions/{sid}"
    assert session["provider"] == "local" and session["status"] == "ready"
    assert client.get(path).status_code == 404
    assert client.post(f"{path}/questions", json={"question": "Which workflows have friction?"}).status_code == 404

    phone = {"X-Loggy-Token": token}
    phone_view = client.get(path, headers=phone)
    assert phone_view.status_code == 200
    assert "token" not in phone_view.json() and "pin" not in phone_view.json()
    assert phone_view.headers["cache-control"] == "no-store"

    called = []
    def start(question, snapshot_id, *, presenter):
        called.append((question, snapshot_id, presenter))
        return "run-test"
    monkeypatch.setattr(api, "start_question", start)
    asked = client.post(f"{path}/questions", json={"question": "Which workflows have friction?"}, headers=phone)
    assert asked.status_code == 200 and asked.json() == {"run_id": "run-test"}
    assert called == [("Which workflows have friction?", None, True)]
    assert client.get(path, headers=phone).json()["thread"][0]["run_id"] == "run-test"

    ended = client.delete(path, headers=phone)
    assert ended.status_code == 200 and ended.json()["status"] == "ended"
    assert client.post(f"{path}/questions", json={"question": "Another"}, headers=phone).status_code == 410


def test_production_fails_closed_without_netbird(client, monkeypatch):
    monkeypatch.setenv("LOGLESS_ENV", "production")
    response = client.post("/api/remote/sessions", headers=PRESENTER)
    assert response.status_code == 503 and response.json()["code"] == "remote_unavailable"


class FakeNetBird:
    def __init__(self):
        self.deleted: list[str] = []
        self.fail_once = True

    def proxy_domain(self):
        return "demo.proxy.netbird.io"

    def create_service(self, name, domain, **kwargs):
        assert kwargs["peer_id"] == "peer-test" and kwargs["port"] == 8080
        assert len(kwargs["pin"]) == 6
        return netbird.Service("service-test", name, domain, "pending", ("peer-test",))

    def get_service(self, service_id):
        assert service_id == "service-test"
        return netbird.Service(service_id, "loggy-session", "demo.proxy.netbird.io", "active", ("peer-test",))

    def list_services(self):
        return []

    def delete_service(self, service_id):
        if self.fail_once:
            self.fail_once = False
            raise netbird.NetBirdError("temporary failure")
        self.deleted.append(service_id)


def test_netbird_url_deletion_retries_after_failure(client, monkeypatch):
    fake = FakeNetBird()
    monkeypatch.setattr(remote, "_nb", fake)
    monkeypatch.setenv("NETBIRD_PEER_ID", "peer-test")
    created = client.post("/api/remote/sessions", headers=PRESENTER).json()
    sid = created["session_id"]
    assert created["status"] in ("provisioning", "ready") and created["pin"]
    assert created["url"].startswith("https://loggy-")
    for _ in range(50):
        if client.get(f"/api/remote/sessions/{sid}", headers=PRESENTER).json()["status"] == "ready":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("NetBird service did not become ready")

    ended = client.delete(f"/api/remote/sessions/{sid}", headers=PRESENTER).json()
    assert ended["status"] == "ended" and ended["provider"] == "netbird"
    assert not fake.deleted
    remote._reap_once()
    assert fake.deleted == ["service-test"]
    assert remote._sessions[sid].service_id is None


def test_reconcile_only_deletes_own_peer_services(monkeypatch):
    class Orphans(FakeNetBird):
        def list_services(self):
            return [
                netbird.Service("ours", "loggy-old", "old.example", "active", ("peer-test",)),
                netbird.Service("theirs", "loggy-other", "other.example", "active", ("peer-other",)),
            ]

    fake = Orphans()
    fake.fail_once = False
    monkeypatch.setattr(remote, "_nb", fake)
    monkeypatch.setenv("NETBIRD_PEER_ID", "peer-test")
    remote._sessions.clear()
    remote._reconcile()
    assert fake.deleted == ["ours"]


def test_netbird_service_request_and_error_do_not_expose_pin():
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={
                "id": "service-test", "name": "loggy-test", "domain": "loggy-test.example",
                "meta": {"status": "pending"},
                "targets": [{"target_type": "peer", "target_id": "peer-test"}],
            })
        return httpx.Response(400, json={"message": "PIN 123456 is invalid"})

    nb = netbird.NetBird("https://netbird.example", "test-token")
    nb.http.close()
    nb.http = httpx.Client(base_url="https://netbird.example/api", transport=httpx.MockTransport(respond),
                           headers={"Authorization": "Token test-token"})
    try:
        service = nb.create_service("loggy-test", "loggy-test.example", peer_id="peer-test", port=8080, pin="123456")
        assert service.peer_ids == ("peer-test",)
        assert requests[0].url.path == "/api/reverse-proxies/services"
        assert requests[0].headers["Authorization"] == "Token test-token"
        assert b'"pin":"123456"' in requests[0].content
        with pytest.raises(netbird.NetBirdError) as err:
            nb.get_service(service.id)
        assert "123456" not in str(err.value)
    finally:
        nb.http.close()
