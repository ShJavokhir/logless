"""Remote control: pair a phone with a QR code and ask loggy (the question agent) from it.

Each session is its own workload with its own URL. With NetBird configured (logless/netbird.py), creating a
session provisions a reverse-proxy service `loggy-<id>.<proxy domain>` that forwards over WireGuard to this
host's peer and asks for a session PIN before anything loads; ending the session deletes the service, so the
URL stops resolving to logless. Without NetBird (local development) the phone uses REMOTE_LOCAL_URL or the
desktop's own origin, and there is no PIN.

- POST   /api/remote/sessions                   presenter only → the desktop view (QR token, PIN, URL)
- GET    /api/remote/sessions/{id}              presenter → desktop view; X-Loggy-Token → phone view
- POST   /api/remote/sessions/{id}/questions    X-Loggy-Token → {run_id} (runs the normal question pipeline)
- DELETE /api/remote/sessions/{id}              presenter or X-Loggy-Token → the ended session

A session ends when either side disconnects, when its TTL runs out, or when the desktop that created it stops
polling (closed tab), and the reaper deletes its URL. On startup, services left behind by a crash are deleted.
Sessions live in this process's memory only: a restart ends them all, which is the lifecycle we want."""
from __future__ import annotations

import hmac
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .. import netbird
from ..sandbox import runs as runstore
from ..sandbox.plan import sanitize_question

log = logging.getLogger("logless.api.remote")
router = APIRouter()

PREFIX = "loggy-"                 # every NetBird service this module owns starts with this
TOKEN_HEADER = "x-loggy-token"
MAX_SESSIONS = 3
MAX_QUESTIONS = 20
READY_TIMEOUT_S = 120.0           # NetBird proxy must report the service active within this
ENDED_RETENTION_S = 600.0         # an ended session still answers "ended" for this long, then 404
REAP_INTERVAL_S = 5.0


def _ttl_s() -> float:
    return float(os.environ.get("REMOTE_TTL_MIN", "30")) * 60


def _desktop_idle_s() -> float:
    # Browsers throttle a tab hidden for 5+ minutes to about one timer per minute, so this must outlast two polls.
    # Closing the tab ends the session at once (pagehide); this only catches crashes and sleep.
    return float(os.environ.get("REMOTE_DESKTOP_IDLE_S", "150"))


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Session:
    id: str
    token: str
    pin: str | None
    url: str | None                 # phone origin; None = the desktop's own origin (local provider)
    service_id: str | None
    status: str                     # provisioning | ready | ended
    expires_at: float
    desktop_seen: float
    phone_seen: float | None = None
    ended_at: float | None = None
    end_reason: str | None = None
    thread: list[dict] = field(default_factory=list)   # {question, run_id, asked_at}

    def view(self, *, desktop: bool) -> dict:
        out = {
            "session_id": self.id,
            "status": self.status,
            "provider": "netbird" if self.pin is not None else "local",
            "url": self.url,
            "expires_at": _iso(self.expires_at),
            "phone_connected": self.phone_seen is not None and time.time() - self.phone_seen < 15,
            "end_reason": self.end_reason,
            "thread": list(self.thread),
        }
        if desktop:
            out |= {"token": self.token, "pin": self.pin}
        return out


_sessions: dict[str, Session] = {}
_lock = threading.Lock()
_nb: netbird.NetBird | None = None
_reaper: threading.Thread | None = None
_stop = threading.Event()


def _client() -> netbird.NetBird | None:
    global _nb
    if _nb is None and netbird.configured():
        _nb = netbird.NetBird()
    return _nb


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status, headers={"Cache-Control": "no-store"})


def _presenter(request: Request) -> bool:
    return bool(getattr(request.state, "presenter", False))


def _token_ok(request: Request, s: Session) -> bool:
    got = request.headers.get(TOKEN_HEADER, "")
    return bool(got) and hmac.compare_digest(got.encode(), s.token.encode())


def _end(s: Session, reason: str) -> None:
    """Mark ended (under _lock) and delete the NetBird service outside it."""
    with _lock:
        if s.status == "ended":
            return
        s.status, s.end_reason, s.ended_at = "ended", reason, time.time()
    _delete_service(s)


def _delete_service(s: Session) -> None:
    """Keep the service ID until deletion succeeds, so the reaper can retry."""
    sid = s.service_id
    if sid and (nb := _client()):
        try:
            nb.delete_service(sid)
            with _lock:
                if s.service_id == sid:
                    s.service_id = None
            log.info("remote session %s: NetBird service deleted", s.id)
        except netbird.NetBirdError as e:
            log.error("remote session %s: could not delete NetBird service: %s", s.id, e)


def _await_ready(s: Session) -> None:
    nb = _client()
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline and s.status == "provisioning" and not _stop.is_set():
        try:
            status = nb.get_service(s.service_id).status   # type: ignore[union-attr, arg-type]
        except netbird.NetBirdError as e:
            log.warning("remote session %s: status check failed: %s", s.id, e)
            status = "pending"
        if status == "active":
            with _lock:
                if s.status == "provisioning":
                    s.status = "ready"
            return
        if status in ("certificate_failed", "error"):
            _end(s, f"netbird_{status}")
            return
        _stop.wait(1.0)
    if s.status == "provisioning":
        _end(s, "netbird_timeout")


def _reap_once() -> None:
    now, idle = time.time(), _desktop_idle_s()
    with _lock:
        live = [s for s in _sessions.values() if s.status != "ended"]
        pending_delete = [s for s in _sessions.values() if s.status == "ended" and s.service_id]
    for s in pending_delete:
        _delete_service(s)
    with _lock:
        for sid in [k for k, s in _sessions.items() if s.status == "ended" and not s.service_id
                    and now - (s.ended_at or now) > ENDED_RETENTION_S]:
            del _sessions[sid]
    for s in live:
        if now >= s.expires_at:
            _end(s, "expired")
        elif now - s.desktop_seen > idle:
            _end(s, "desktop_gone")


def _reconcile() -> None:
    """Delete loggy-* services a previous process left behind (crash, kill -9)."""
    nb = _client()
    if nb is None:
        return
    with _lock:
        mine = {s.service_id for s in _sessions.values()}
    try:
        peer_id = os.environ["NETBIRD_PEER_ID"]
        orphans = [svc for svc in nb.list_services() if svc.name.startswith(PREFIX)
                   and peer_id in svc.peer_ids and svc.id not in mine]
        for svc in orphans:
            nb.delete_service(svc.id)
        if orphans:
            log.warning("deleted %d orphaned remote-session NetBird services", len(orphans))
    except netbird.NetBirdError as e:
        log.error("remote: could not reconcile NetBird services: %s", e)


def _reap_loop() -> None:
    _reconcile()
    while not _stop.wait(REAP_INTERVAL_S):
        try:
            _reap_once()
        except Exception as e:  # noqa: BLE001 — the reaper must outlive one bad pass
            log.error("remote reaper pass failed (%s)", type(e).__name__)


def start() -> None:
    global _reaper
    _stop.clear()
    if _reaper is None or not _reaper.is_alive():
        _reaper = threading.Thread(target=_reap_loop, name="logless-remote-reaper", daemon=True)
        _reaper.start()


def stop() -> None:
    """End every live session so no URL outlives the process."""
    _stop.set()
    with _lock:
        live = [s for s in _sessions.values() if s.status != "ended"]
    for s in live:
        _end(s, "server_stopped")


# ---------------------------------------------------------------- routes

class QuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=200)


def _get(sid: str) -> Session | None:
    with _lock:
        return _sessions.get(sid)


@router.post("/api/remote/sessions", status_code=201)
def create_session(request: Request):
    if not _presenter(request):
        return _err(403, "presenter_required", "Remote control is presenter-only.")
    nb = _client()
    if nb is None and os.environ.get("LOGLESS_ENV", "development") == "production":
        return _err(503, "remote_unavailable", "Remote control needs NetBird (NETBIRD_API_URL, NETBIRD_API_TOKEN, NETBIRD_PEER_ID).")
    with _lock:
        if sum(s.status != "ended" for s in _sessions.values()) >= MAX_SESSIONS:
            return _err(429, "too_many_sessions", "End an existing remote session first.")
        sid = secrets.token_hex(4)
        now = time.time()
        s = Session(id=sid, token=secrets.token_urlsafe(24), pin=None, url=os.environ.get("REMOTE_LOCAL_URL") or None,
                    service_id=None, status="provisioning" if nb else "ready",
                    expires_at=now + _ttl_s(), desktop_seen=now)
        _sessions[sid] = s
    if nb is not None:
        try:
            domain = f"{PREFIX}{sid}.{nb.proxy_domain()}"
            s.pin = f"{secrets.randbelow(10**6):06d}"
            svc = nb.create_service(f"{PREFIX}{sid}", domain, peer_id=os.environ["NETBIRD_PEER_ID"],
                                    port=int(os.environ.get("NETBIRD_TARGET_PORT", "8080")), pin=s.pin)
        except netbird.NetBirdError as e:
            log.error("remote: could not create NetBird service: %s", e)
            with _lock:
                _sessions.pop(sid, None)
            return _err(502, "netbird_failed", "NetBird could not provision a URL for this session.")
        s.service_id, s.url, s.status = svc.id, f"https://{svc.domain}", "provisioning"
    if s.status == "provisioning":
        threading.Thread(target=_await_ready, args=(s,), name=f"logless-remote-{sid}", daemon=True).start()
    log.info("remote session %s created (%s)", sid, "netbird" if s.service_id else "local")
    return s.view(desktop=True)


@router.get("/api/remote/sessions/{sid}")
def get_session(sid: str, request: Request):
    s = _get(sid)
    if s is None:
        return _err(404, "not_found", "Unknown remote session.")
    if _presenter(request):
        s.desktop_seen = time.time()
        return s.view(desktop=True)
    if _token_ok(request, s):
        if s.status != "ended":
            s.phone_seen = time.time()
        return s.view(desktop=False)
    return _err(404, "not_found", "Unknown remote session.")


@router.post("/api/remote/sessions/{sid}/questions")
def ask(sid: str, body: QuestionIn, request: Request):
    from . import app as api   # lazy: app.py includes this router
    with _lock:
        s = _sessions.get(sid)
        if s is None or not _token_ok(request, s):
            return _err(404, "not_found", "Unknown remote session.")
        if s.status != "ready":
            return _err(410, "session_ended", "This remote session has ended.")
        if len(s.thread) >= MAX_QUESTIONS:
            return _err(429, "question_limit", f"This session has used its {MAX_QUESTIONS} questions. Pair again for more.")
        if s.thread and (last := runstore.load(s.thread[-1]["run_id"])) and last["state"] not in runstore.TERMINAL:
            return _err(409, "question_in_flight", "loggy is still answering the last question.")
        # The presenter opened this session, so its questions spend the presenter's budget.
        run_id = api.start_question(body.question, None, presenter=True)
        s.thread.append({"question": sanitize_question(body.question.strip()), "run_id": run_id, "asked_at": _iso(time.time())})
    return {"run_id": run_id}


@router.delete("/api/remote/sessions/{sid}")
def end_session(sid: str, request: Request):
    s = _get(sid)
    if s is None:
        return _err(404, "not_found", "Unknown remote session.")
    desktop = _presenter(request)
    if not desktop and not _token_ok(request, s):
        return _err(404, "not_found", "Unknown remote session.")
    _end(s, "desktop_disconnected" if desktop else "phone_disconnected")
    return s.view(desktop=desktop)
