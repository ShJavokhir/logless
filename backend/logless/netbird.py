"""Minimal client for the NetBird management API's reverse-proxy services
(https://docs.netbird.io/api/resources/services). logless uses it for one thing: give each remote-control
session its own public URL that NetBird's proxy serves over WireGuard to the app VM's peer, gated by a PIN,
and delete that URL when the session ends.

Configuration (all from the environment, see .env.example):
  NETBIRD_API_URL       management URL, e.g. https://netbird.example.com (self-hosted) or https://api.netbird.io
  NETBIRD_API_TOKEN     personal access token of a service user
  NETBIRD_PEER_ID       the peer that runs logless (the proxy's target)
  NETBIRD_TARGET_PORT   the port logless listens on at that peer's NetBird IP (default 8080)
  NETBIRD_PROXY_DOMAIN  proxy cluster domain the session hosts go under (default: the first online cluster)
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import httpx

TIMEOUT_S = 10.0


class NetBirdError(RuntimeError):
    """The management API refused or failed a request. The message never contains the token."""


@dataclass(frozen=True)
class Service:
    id: str
    name: str
    domain: str
    status: str   # meta.status: pending | active | tunnel_not_created | certificate_pending | certificate_failed | error


def configured() -> bool:
    return bool(os.environ.get("NETBIRD_API_URL") and os.environ.get("NETBIRD_API_TOKEN") and os.environ.get("NETBIRD_PEER_ID"))


class NetBird:
    def __init__(self, url: str | None = None, token: str | None = None):
        url = (url or os.environ.get("NETBIRD_API_URL", "")).rstrip("/")
        token = token or os.environ.get("NETBIRD_API_TOKEN", "")
        if not url or not token:
            raise NetBirdError("NETBIRD_API_URL and NETBIRD_API_TOKEN must be set")
        self.http = httpx.Client(base_url=f"{url}/api", timeout=TIMEOUT_S,
                                 headers={"Authorization": f"Token {token}", "Accept": "application/json"})

    def _call(self, method: str, path: str, body: dict | None = None):
        try:
            r = self.http.request(method, path, json=body)
        except httpx.HTTPError as e:
            raise NetBirdError(f"{method} {path}: {type(e).__name__}") from None
        if r.status_code >= 400:
            try:
                msg = str(r.json().get("message", ""))[:200]
            except ValueError:
                msg = ""
            raise NetBirdError(f"{method} {path}: HTTP {r.status_code} {msg}".strip())
        return r.json() if r.content else None

    @staticmethod
    def _service(d: dict) -> Service:
        return Service(id=d["id"], name=d["name"], domain=d["domain"], status=(d.get("meta") or {}).get("status", "pending"))

    def proxy_domain(self) -> str:
        """NETBIRD_PROXY_DOMAIN, else the address of the first online proxy cluster."""
        if dom := os.environ.get("NETBIRD_PROXY_DOMAIN"):
            return dom
        clusters = self._call("GET", "/reverse-proxies/clusters") or []
        online = [c["address"] for c in clusters if c.get("online")]
        if not online:
            raise NetBirdError("no online NetBird proxy cluster; set NETBIRD_PROXY_DOMAIN or start the proxy")
        return online[0]

    def create_service(self, name: str, domain: str, *, peer_id: str, port: int, pin: str) -> Service:
        """An HTTP service at `domain` that forwards to `peer_id:port` over WireGuard, behind a PIN page."""
        body = {
            "name": name,
            "domain": domain,
            "mode": "http",
            "enabled": True,
            "targets": [{"target_id": peer_id, "target_type": "peer", "protocol": "http", "port": port,
                         "path": "/", "enabled": True}],
            "auth": {"pin_auth": {"enabled": True, "pin": pin}},
        }
        return self._service(self._call("POST", "/reverse-proxies/services", body))

    def get_service(self, service_id: str) -> Service:
        return self._service(self._call("GET", f"/reverse-proxies/services/{service_id}"))

    def list_services(self) -> list[Service]:
        return [self._service(d) for d in self._call("GET", "/reverse-proxies/services") or []]

    def delete_service(self, service_id: str) -> None:
        try:
            self._call("DELETE", f"/reverse-proxies/services/{service_id}")
        except NetBirdError as e:
            if "HTTP 404" not in str(e):   # already gone is the outcome we wanted
                raise
