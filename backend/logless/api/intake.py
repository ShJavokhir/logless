"""Live intake endpoints (docs/CONTRACTS.md §11). Included from app.py with one line.

- POST /api/intake/runs            presenter only → {run_id}; 403 presenter_required, 409 intake_not_ready | intake_in_flight
- GET  /api/intake/runs/{id}/events?after=<seq>   up to 200 events per call (poll ~300 ms)
- GET  /api/intake/status          public → {ready, batch_size, base_snapshot_id}
- POST /api/intake/reset           presenter only → re-publish the base snapshot, clear the batch's decisions

The run engine lives in logless/intake.py; this module only holds the in-memory event store for the
runs of this process (the Run record itself is persisted in public.db `runs`, kind "intake")."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .. import db
from .. import intake as engine
from . import serializers

log = logging.getLogger("logless.api.intake")
router = APIRouter()

_runs: dict[str, engine.IntakeRun] = {}
_lock = threading.Lock()          # guards _active across the worker thread
_alock = asyncio.Lock()           # serializes start/reset requests on the event loop
_active: str | None = None
MAX_EVENTS = 200
MAX_RETAINED_RUNS = 8


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status, headers={"Cache-Control": "no-store"})


def _presenter(request: Request) -> bool:
    """Reuse the app middleware's decision (request.state.presenter); fall back to the same constant-time
    PRESENTER_KEY check when the router is mounted without that middleware (tests)."""
    val = getattr(request.state, "presenter", None)
    if val is not None:
        return bool(val)
    key = os.environ.get("PRESENTER_KEY", "")
    got = request.headers.get("x-logless-presenter", "")
    return bool(key and got) and hmac.compare_digest(got.encode(), key.encode())


def _in_flight() -> bool:
    return _active is not None and _runs.get(_active) is not None and _runs[_active].state == "running"


def _drive(run: engine.IntakeRun) -> None:
    global _active
    try:
        engine.run_batch(run)
    except engine.IntakeError as e:
        run.finish(error=(e.code, str(e)[:200]))
    except Exception as e:  # never leak details
        log.error("intake run failed (%s)", type(e).__name__)
        run.finish(error=("intake_failed", "The intake run could not finish; reload to check the current snapshot."))
    finally:
        with _lock:
            if _active == run.id:
                _active = None


@router.post("/api/intake/runs")
async def start_run(request: Request):
    global _active
    if not _presenter(request):
        return _err(403, "presenter_required", "Live intake is presenter-only.")
    async with _alock:
        if _in_flight():
            return _err(409, "intake_in_flight", "An intake run is already in progress.")
        st = await run_in_threadpool(engine.status)
        if not st["ready"]:
            return _err(409, "intake_not_ready", "No prepared intake batch is ready for the current snapshot.")
        run = await run_in_threadpool(engine.IntakeRun, st["base_snapshot_id"], st["batch_size"])
        with _lock:
            # Only recent presenter streams need in-memory events; older completion records
            # remain in SQLite and can still be polled after their event log is evicted.
            for rid in list(_runs):
                if len(_runs) < MAX_RETAINED_RUNS:
                    break
                if _runs[rid].state != "running":
                    del _runs[rid]
            _runs[run.id] = run
            _active = run.id
    threading.Thread(target=_drive, args=(run,), daemon=True, name="logless-intake").start()
    return {"run_id": run.id}


@router.get("/api/intake/runs/{run_id}/events")
def run_events(run_id: str, request: Request, after: int = Query(0, ge=0, le=1_000_000)):
    if not _presenter(request):
        return _err(403, "presenter_required", "Live intake diagnostics are presenter-only.")
    run = _runs.get(run_id)
    if run is not None:
        return serializers.serialize_intake_events(run.page(after, MAX_EVENTS))
    # a run from before a restart: its record survives, its event log does not
    row = db.public().execute("SELECT json FROM runs WHERE run_id = ? AND kind = 'intake'", (run_id,)).fetchone()
    if row is None:
        return _err(404, "not_found", "Not found.")
    d = json.loads(row["json"])
    state = {"completed": "completed", "failed": "failed"}.get(d.get("state"), "failed")
    out = {"run_id": run_id, "state": state, "stage": "done" if state == "completed" else "deciding",
           "counters": {"total": (d.get("intake") or {}).get("batch_size", 0), "decided": (d.get("intake") or {}).get("decided", 0),
                        "per_second": 0.0, "p50_ms": 0, "decisions_per_conversation": 5},
           "events": []}
    if state == "completed":
        out["intake"] = serializers._intake(d.get("intake"))   # same allowlist as GET /api/runs/{id}
    else:
        out["error"] = d.get("error") or {"code": "interrupted", "message": "The run was interrupted by a restart."}
    return serializers.serialize_intake_events(out)


@router.get("/api/intake/status")
def intake_status():
    st = engine.status()
    return {"ready": bool(st["ready"]), "batch_size": int(st["batch_size"]), "base_snapshot_id": st["base_snapshot_id"]}


@router.post("/api/intake/reset")
async def intake_reset(request: Request):
    if not _presenter(request):
        return _err(403, "presenter_required", "Live intake is presenter-only.")
    async with _alock:
        if _in_flight():
            return _err(409, "intake_in_flight", "An intake run is in progress; reset after it finishes.")
        try:
            out = await run_in_threadpool(engine.reset)
        except engine.IntakeError as e:
            return _err(409, e.code, str(e))
    return {"status": "reset", "snapshot_id": out.get("snapshot_id"), "batch_size": out.get("batch_size", 0)}
