"""logless web API (docs/CONTRACTS.md §6). Served by `logless serve` on 127.0.0.1:8000 behind Caddy.

- Reads only public.db, except the sandbox export (private typed assignments) for live analyses.
- Background runs execute in a thread pool; run state lives in public.db.runs.
- Every browser payload is built by the allowlist serializers.
- Errors are {code, message}; no stack traces; quiet logs (no prompts, completions or bodies).
- Per-IP token buckets and request size limits; CORS only for local dev (http://localhost:5173).
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import db
from ..config import settings
from ..providers.http import ProviderError
from ..sandbox import runs as runstore
from ..sandbox.analysis import run_analysis
from ..sandbox.client import RunnerClient
from ..sandbox.containment import run_containment
from . import brief_video, briefs, models, prds, search, serializers, stories
from ..sandbox.plan import normalize_question, sanitize_question
from .ratelimit import HourlyBudget, RateLimiter, presenter_limits

log = logging.getLogger("logless.api")
MAX_BODY = 8 * 1024
MAX_ACTIVE_RUNS = 4
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# Load the development .env before reading budgets/pool sizes; production already
# supplies these through the service environment. Otherwise .env overrides are ignored.
settings()
SEARCH_CONCURRENCY = int(os.environ.get("LOGLESS_SEARCH_CONCURRENCY", "4"))
SEARCH_MAX_PENDING = 16   # distinct queries in flight at once (identical queries coalesce)
SEARCH_WAIT_S = 25.0


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict[str, str] | None = None):
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def err(status: int, code: str, message: str, headers: dict[str, str] | None = None, **extra) -> JSONResponse:
    return JSONResponse({"code": code, "message": message, **extra}, status_code=status,
                        headers={"Cache-Control": "no-store", **(headers or {})})


# ---------------------------------------------------------------- snapshot store

class SnapshotStore:
    """The current published snapshot, parsed and serialized once per snapshot id."""

    def __init__(self):
        self.lock = threading.Lock()
        self.snap_id: str | None = None
        self.raw: dict | None = None
        self.body: bytes | None = None
        self.checked = 0.0

    def current(self) -> tuple[dict, bytes] | None:
        with self.lock:
            row = db.public().execute("SELECT snapshot_id FROM snapshots WHERE is_current=1 ORDER BY created_at DESC LIMIT 1").fetchone()
            if row is None:
                self.snap_id = self.raw = self.body = None
                return None
            if row["snapshot_id"] != self.snap_id or self.body is None:
                full = db.public().execute("SELECT json FROM snapshots WHERE snapshot_id=?", (row["snapshot_id"],)).fetchone()
                raw = json.loads(full["json"])
                out = serializers.serialize_snapshot(raw)   # raises Blocked on any allowlist / leak failure
                self.snap_id, self.raw = row["snapshot_id"], out
                self.body = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode()
            return self.raw, self.body  # type: ignore[return-value]

    def current_id(self) -> str | None:
        try:
            cur = self.current()
        except serializers.Blocked:
            return None
        return cur[0]["snapshot_id"] if cur else None


store = SnapshotStore()
limiter = RateLimiter()
budget = HourlyBudget()
presenter_budget = HourlyBudget(presenter_limits())
PRESENTER_HEADER = "x-logless-presenter"
PRESENTER_RESERVED_RUNS = 2   # run slots above MAX_ACTIVE_RUNS that only the presenter can use
executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="logless-run")
# Search runs on its own small pool, so slow Jev calls can never occupy the request threadpool
# that serves health checks and run polling.
search_executor = ThreadPoolExecutor(max_workers=SEARCH_CONCURRENCY, thread_name_prefix="logless-search")
_search_flights: dict[tuple[str, str], Future] = {}
_active = 0
_active_lock = threading.Lock()
_start_lock = threading.RLock()  # a just-completed Future can invoke its callback during submission
_story_inflight: dict[tuple[str, str], str] = {}
_prd_inflight: dict[tuple[str, str], str] = {}
_brief_inflight: dict[str, str] = {}
_question_inflight: dict[tuple[str, str], str] = {}
_runner: RunnerClient | None = None
_health_cache: tuple[float, str] = (0.0, "unreachable")


def _subthemes_for(snapshot_id: str) -> dict | None:
    """The stored sub-themes of the build behind a snapshot: its own build (private `builds`), an
    intake snapshot's base build (`intake_batches`), else the build recorded with its cluster map."""
    from ..intake import build_of_snapshot
    from ..pipeline.subthemes import load_for_build
    from ..sandbox.export import load_cluster_map
    build_id = build_of_snapshot(snapshot_id)
    if build_id is None:
        cm = load_cluster_map(snapshot_id)
        build_id = cm[0] if cm else None
    return load_for_build(build_id) if build_id else None


def _subtheme_nodes(snap: dict, titles: dict[str, str]) -> tuple[dict[str, str], dict[str, dict]]:
    """Titles and published counts of the snapshot's sub-themes, as GET /api/subthemes serves them
    (an untitled sub-theme is named after its workflow). Empty when there are none."""
    try:
        raw = _subthemes_for(snap["snapshot_id"])
        pub = serializers.serialize_subthemes(snap["snapshot_id"], raw) if raw else None
    except serializers.Blocked:
        log.warning("sub-themes of %s failed serialization; questions will not see them", snap["snapshot_id"])
        pub = None
    sub_titles: dict[str, str] = {}
    sub_nodes: dict[str, dict] = {}
    for lid, items in ((pub or {}).get("leaves") or {}).items():
        leaf = titles.get(lid, lid)
        for x in items:
            sub_titles[x["id"]] = x["short_title"] or (f"Rest of {leaf}" if x.get("rest") else f"Unnamed part of {leaf}")
            sub_nodes[x["id"]] = {"id": x["id"], "level": 3, "conversations": x["conversations"], "users": x["users"]}
    return sub_titles, sub_nodes


def runner() -> RunnerClient:
    global _runner
    if _runner is None:
        _runner = RunnerClient()
    return _runner


def sandbox_status(fresh: bool = False) -> str:
    global _health_cache
    ts, val = _health_cache
    if not fresh and time.monotonic() - ts < 3.0:
        return val
    ok = runner().health(timeout=1.5)
    val = "reachable" if ok and ok.get("status") == "ok" else "unreachable"
    _health_cache = (time.monotonic(), val)
    return val


def health_status(fresh: bool = False) -> dict:
    snap = store.current_id()
    sandbox = sandbox_status(fresh)
    return {"status": "ok" if snap and sandbox == "reachable" else "degraded", "sandbox": sandbox, "snapshot_id": snap}


def _require_snapshot(snapshot_id: str | None = None) -> dict:
    try:
        cur = store.current()
    except serializers.Blocked:
        raise ApiError(503, "snapshot_blocked", "The current snapshot failed a publication check and is not served.")
    if cur is None:
        raise ApiError(503, "no_snapshot", "No snapshot has been published yet.")
    snap = cur[0]
    if snapshot_id is not None and snapshot_id != snap["snapshot_id"]:
        raise ApiError(409, "stale_snapshot", "That snapshot is no longer current; reload the page.")
    return snap


def _published(snapshot_id: str) -> dict:
    """Any published snapshot (current or earlier), served through the same allowlist serializer."""
    row = None
    if serializers.SNAPSHOT_ID.match(snapshot_id):
        row = db.public().execute("SELECT json FROM snapshots WHERE snapshot_id=?", (snapshot_id,)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "No published snapshot has that id.")
    try:
        return serializers.serialize_snapshot(json.loads(row["json"]))
    except serializers.Blocked:
        raise ApiError(503, "snapshot_blocked", "That snapshot failed a publication check and is not served.")


def _submit(fn: Callable[[], None], on_done: Callable[[], None] | None = None,
            *, run: runstore.Run | None = None) -> Future:
    global _active
    admission = threading.Event()
    admitted = False

    def execute_admitted():
        # ThreadPoolExecutor can enqueue a work item before creating a worker. If
        # thread creation fails, that item may later be picked up by another worker.
        admission.wait()
        if admitted:
            fn()

    def settled(future: Future) -> None:
        global _active
        try:
            if future.cancelled():
                if run is not None:
                    run.fail("server_stopping", "The server stopped before this run could start.")
            elif (failure := future.exception()) is not None:
                log.error("background run failed (%s)", type(failure).__name__)
                if run is not None and run.doc["state"] not in runstore.TERMINAL:
                    run.fail("internal_error", "The run could not finish.")
        except Exception as failure:
            log.error("could not record background failure (%s)", type(failure).__name__)
        finally:
            with _active_lock:
                _active -= 1
            if on_done:
                on_done()

    with _active_lock:
        _active += 1
    try:
        future = executor.submit(execute_admitted)
    except Exception:
        # No worker will run a finally block when scheduling itself fails. Settle the
        # reservation and saved run just as a cancelled queue entry would be settled.
        cancelled = Future()
        cancelled.cancel()
        admission.set()  # any internally enqueued item must exit without executing fn
        settled(cancelled)
        raise ApiError(503, "server_stopping", "The server cannot start a new run right now; retry shortly.") from None
    admitted = True
    admission.set()
    future.add_done_callback(settled)
    return future


def is_presenter(request: Request) -> bool:
    """True only if PRESENTER_KEY is set and the header matches it (constant-time). A wrong or
    missing key is silently treated as a public request."""
    key = os.environ.get("PRESENTER_KEY", "")
    got = request.headers.get(PRESENTER_HEADER, "")
    if not key or not got:
        return False
    return hmac.compare_digest(got.encode(), key.encode())


def _capacity(presenter: bool = False) -> None:
    limit = MAX_ACTIVE_RUNS + (PRESENTER_RESERVED_RUNS if presenter else 0)
    with _active_lock:
        if _active >= limit:
            raise ApiError(429, "busy", "Too many runs in progress; try again in a moment.")


def _spend(kind: str, presenter: bool = False) -> None:
    """Consume one unit of the global hourly budget (or the presenter's), or refuse honestly."""
    retry = (presenter_budget if presenter else budget).take(kind)
    if retry is not None:
        mins = max(1, round(retry / 60))
        raise ApiError(429, "budget_exhausted",
                       f"The live demo has used its hourly budget for {HourlyBudget.label(kind)}. Saved results still "
                       f"work; new ones are available again in about {mins} minute{'s' if mins != 1 else ''}.",
                       headers={"Retry-After": str(retry)})


def _release_later(table: dict, key, rid: str) -> Callable[[], None]:
    def release() -> None:
        with _start_lock:  # only drop the entry if it still belongs to this run
            if table.get(key) == rid:
                del table[key]
    return release


def _shutdown_runs() -> None:
    # submit takes _start_lock before the executor's internal shutdown lock. Cancellation
    # invokes callbacks synchronously; preserve that order so callbacks can reenter it.
    with _start_lock:
        executor.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------- middleware

def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if fwd and peer in ("127.0.0.1", "::1"):
        return fwd.split(",")[-1].strip()[:64]   # the entry Caddy appended
    return peer


def bucket_for(method: str, path: str) -> str:
    if method == "POST":
        if path == "/api/search":
            return "search"
        if path == "/api/analyses":
            return "analysis"
        if path == "/api/demo/containment":
            return "containment"
        if path.endswith("/story"):
            return "story"
        if path.endswith("/prd"):
            return "prd"
        if path == "/api/brief":
            return "brief"
    return "default"


class BodyLimit:
    """Pure ASGI: reject bodies larger than MAX_BODY (declared or streamed)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers", []):
            if k == b"content-length":
                if not v.isdigit() or len(v) > 20 or int(v) > MAX_BODY:
                    return await err(413, "payload_too_large", "Request body too large.")(scope, receive, send)
        # Intake trigger/reset endpoints don't parse a body. Enforce the limit before
        # dispatch for those too, rather than depending on the endpoint to call receive.
        body = bytearray()
        while True:
            msg = await receive()
            if msg["type"] == "http.request":
                chunk = msg.get("body", b"")
                if len(body) + len(chunk) > MAX_BODY:
                    return await err(413, "payload_too_large", "Request body too large.")(scope, receive, send)
                body.extend(chunk)
                if not msg.get("more_body", False):
                    break
            elif msg["type"] == "http.disconnect":
                return
        body = bytes(body)
        delivered = False

        async def buffered():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, buffered, send)


# ---------------------------------------------------------------- app

@asynccontextmanager
async def lifespan(_: FastAPI):
    global executor, search_executor
    from .. import intake
    if intake.recover_interrupted_publication():
        log.warning("recovered an intake interrupted before publication; the base snapshot stays current")
    n = runstore.fail_interrupted()
    if n:
        log.warning("marked %d interrupted runs as failed", n)
    if getattr(executor, "_shutdown", False):
        executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="logless-run")
    if getattr(search_executor, "_shutdown", False):
        search_executor = ThreadPoolExecutor(max_workers=SEARCH_CONCURRENCY, thread_name_prefix="logless-search")
    _search_flights.clear()
    yield
    _shutdown_runs()
    search_executor.shutdown(wait=False, cancel_futures=True)


def create_app() -> FastAPI:
    settings()  # loads .env
    logging.getLogger("httpx").setLevel(logging.WARNING)  # quiet logs: no per-request URL lines
    from ..sandbox.containment import TASKS_DIR
    if not (TASKS_DIR / "followup.py").exists():
        log.error("sandbox task programs not found at %s: the containment check will fail "
                  "(run the API from the repo tree)", TASKS_DIR)
    app = FastAPI(title="logless", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    if os.environ.get("LOGLESS_ENV", "development") != "production":
        app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["GET", "POST"],
                           allow_headers=["Content-Type", "X-Logless-Presenter"], allow_credentials=False, max_age=600)

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        # The presenter (valid X-Logless-Presenter) skips the per-IP buckets but still has its own
        # hourly budget; everyone else is rate-limited per IP.
        request.state.presenter = is_presenter(request)
        if request.url.path.startswith("/api/") and request.method != "OPTIONS" and not request.state.presenter:
            if not limiter.allow(client_ip(request), bucket_for(request.method, request.url.path)):
                return err(429, "rate_limited", "Too many requests; slow down.")
        resp = await call_next(request)
        resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, e: ApiError):
        return err(e.status, e.code, e.message, headers=e.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", ())[1:]) or "body"
        return err(422, "invalid_request", f"Invalid field: {loc}"[:120])

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "http_error")
        return err(e.status_code, code, {404: "Not found.", 405: "Method not allowed."}.get(e.status_code, "Request failed."))

    @app.exception_handler(serializers.Blocked)
    async def _blocked(_: Request, e: serializers.Blocked):
        log.error("payload blocked by the allowlist serializer")
        return err(503, "blocked", "This content failed a publication check and is not served.")

    @app.exception_handler(ProviderError)
    async def _provider(_: Request, e: ProviderError):
        log.warning("provider %s failed code=%s", e.provider, e.code)
        return err(503, "model_unavailable", "A model provider is unavailable right now.")

    @app.exception_handler(Exception)
    async def _any(_: Request, e: Exception):
        log.error("unhandled %s", type(e).__name__)
        return err(500, "internal_error", "Internal error.")

    # ------------------------------------------------------------ routes

    @app.get("/api/health")
    def api_health():
        return health_status()

    @app.get("/api/snapshot")
    def api_snapshot():
        _require_snapshot()
        cur = store.current()
        return Response(cur[1], media_type="application/json")  # type: ignore[index]

    @app.get("/api/snapshots/{snapshot_id}/diff")
    def api_snapshot_diff(snapshot_id: str):
        cur = _published(snapshot_id)
        if cur.get("previous_snapshot_id") is None:
            raise ApiError(404, "no_previous_snapshot", "That snapshot is not linked to an earlier snapshot.")
        return serializers.snapshot_diff(cur, _published(cur["previous_snapshot_id"]))

    @app.post("/api/search")
    async def api_search(body: models.SearchIn, request: Request):
        snap = await run_in_threadpool(_require_snapshot, body.snapshot_id)
        q = body.query.strip()
        if not q:
            raise ApiError(422, "invalid_request", "Invalid field: query")
        key = search.cache_key(snap["snapshot_id"], q)
        hit = search.cached(key)
        if hit is not None:
            return serializers.serialize_search(snap["snapshot_id"], q, hit, 0)
        # Identical queries in flight share one Jev call (event-loop only, so no lock is needed).
        fut = _search_flights.get(key)
        if fut is None:
            if len(_search_flights) >= SEARCH_MAX_PENDING:
                raise ApiError(429, "busy", "Search is busy; try again in a moment.")
            _spend("search", request.state.presenter)
            fut = search_executor.submit(search.run, snap, q)
            _search_flights[key] = fut
            loop = asyncio.get_running_loop()

            def _done(f: Future, key=key) -> None:
                loop.call_soon_threadsafe(lambda: _search_flights.pop(key, None) if _search_flights.get(key) is f else None)
            fut.add_done_callback(_done)
        try:
            results, elapsed = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(fut)), timeout=SEARCH_WAIT_S)
        except asyncio.TimeoutError:
            raise ApiError(503, "search_timeout", "Search took too long; try again.") from None
        return serializers.serialize_search(snap["snapshot_id"], q, results, elapsed)

    @app.post("/api/analyses")
    def api_analyses(body: models.AnalysisIn, request: Request):
        """Open questions only (usage/friction were retired; the model rejects them with 422)."""
        snap = _require_snapshot(body.snapshot_id)
        presenter = request.state.presenter
        titles = {n["id"]: n["title"] for n in snap["clusters"] + snap["categories"]}
        nodes = {n["id"]: n for n in snap["clusters"] + snap["categories"]}
        sub_titles, sub_nodes = _subtheme_nodes(snap, titles)
        titles, nodes = {**titles, **sub_titles}, {**nodes, **sub_nodes}
        sid = snap["snapshot_id"]
        raw_q = body.question.strip()
        if not raw_q:
            raise ApiError(422, "invalid_request", "Invalid field: question")
        key = (sid, normalize_question(raw_q))
        with _start_lock:
            rid = _question_inflight.get(key)
            if rid:
                existing = runstore.load(rid)
                if existing and existing["state"] not in runstore.TERMINAL:
                    return {"run_id": rid}
            _capacity(presenter)
            _spend("analysis", presenter)
            run = runstore.Run.create("analysis", "question", sid, question=sanitize_question(raw_q))
            _question_inflight[key] = run.id
            _submit(lambda: run_analysis(run, snapshot_id=sid, titles=titles, nodes=nodes, question=raw_q, runner=runner()),
                    on_done=_release_later(_question_inflight, key, run.id), run=run)
        return {"run_id": run.id}

    @app.get("/api/runs/{run_id}")
    def api_run(run_id: str):
        if not serializers.RUN_ID.match(run_id):
            raise ApiError(404, "not_found", "Unknown run.")
        raw = runstore.load(run_id)
        if raw is None:
            raise ApiError(404, "not_found", "Unknown run.")
        if raw["kind"] == "analysis" and raw.get("intent") != "question":
            raise ApiError(410, "run_retired", "This run used a retired analysis type.")
        return serializers.serialize_run(raw)

    @app.post("/api/clusters/{cluster_id}/story")
    def api_story(cluster_id: str, body: models.StoryIn, request: Request):
        snap = _require_snapshot(body.snapshot_id)
        node = next((n for n in snap["clusters"] if n["id"] == cluster_id), None)
        if node is None:
            raise ApiError(404, "not_found", "Unknown cluster.")
        key = (snap["snapshot_id"], cluster_id)
        hit = stories.cached(*key)
        if hit is not None:
            return {"status": "ready", "story": serializers.serialize_story(hit)}
        with _start_lock:
            # Re-check under the lock: a run may have finished and cached its story meanwhile.
            hit = stories.cached(*key)
            if hit is not None:
                return {"status": "ready", "story": serializers.serialize_story(hit)}
            rid = _story_inflight.get(key)
            if rid:
                raw = runstore.load(rid)
                if raw and raw["state"] not in runstore.TERMINAL:
                    return {"status": "pending", "run_id": rid}
            _capacity(request.state.presenter)
            _spend("story", request.state.presenter)
            run = runstore.Run.create("story", None, snap["snapshot_id"])
            _story_inflight[key] = run.id
            _submit(lambda: stories.run_story(run, snapshot_id=snap["snapshot_id"], node=node),
                    on_done=_release_later(_story_inflight, key, run.id), run=run)
        return {"status": "pending", "run_id": run.id}

    @app.post("/api/clusters/{cluster_id}/prd")
    def api_prd(cluster_id: str, body: models.StoryIn, request: Request):
        snap = _require_snapshot(body.snapshot_id)
        node = next((n for n in snap["clusters"] if n["id"] == cluster_id), None)
        if node is None:
            raise ApiError(404, "not_found", "Unknown cluster.")
        key = (snap["snapshot_id"], cluster_id)
        hit = prds.cached(*key)
        if hit is not None:
            return {"status": "ready", "prd": serializers.serialize_prd(hit)}
        with _start_lock:
            # Re-check under the lock: a run may have finished and cached its PRD meanwhile.
            hit = prds.cached(*key)
            if hit is not None:
                return {"status": "ready", "prd": serializers.serialize_prd(hit)}
            rid = _prd_inflight.get(key)
            if rid:
                raw = runstore.load(rid)
                if raw and raw["state"] not in runstore.TERMINAL:
                    return {"status": "pending", "run_id": rid}
            _capacity(request.state.presenter)
            _spend("prd", request.state.presenter)
            run = runstore.Run.create("prd", None, snap["snapshot_id"])
            _prd_inflight[key] = run.id
            clusters = snap["clusters"]
            _submit(lambda: prds.run_prd(run, snapshot_id=snap["snapshot_id"], node=node, clusters=clusters),
                    on_done=_release_later(_prd_inflight, key, run.id), run=run)
        return {"status": "pending", "run_id": run.id}

    def _brief_out(hit: dict) -> dict:
        return serializers.serialize_brief(hit, brief_video.ensure(hit))

    @app.get("/api/brief/{brief_id}/video.mp4")
    def api_brief_video(brief_id: str):
        path = brief_video.video_path(brief_id)
        if path is None:
            raise ApiError(404, "not_found", "No video for that brief.")
        return FileResponse(path, media_type="video/mp4", filename=f"logless-{brief_id}.mp4",
                            headers={"Cache-Control": "public, max-age=86400, immutable"})

    @app.get("/api/brief")
    def api_brief_get(snapshot_id: str | None = None):
        """Latest video brief of that snapshot (default: the current one)."""
        sid = snapshot_id if snapshot_id is not None else store.current_id()
        if sid is None or not serializers.SNAPSHOT_ID.match(sid):
            return {"status": "none"}
        hit = briefs.latest(sid)
        return {"status": "ready", "brief": _brief_out(hit)} if hit else {"status": "none"}

    @app.post("/api/brief")
    def api_brief(request: Request, body: models.BriefIn | None = None):
        body = body or models.BriefIn()
        snap = _require_snapshot(body.snapshot_id)
        sid = snap["snapshot_id"]
        if not body.regenerate:
            hit = briefs.latest(sid)
            if hit is not None:
                return {"status": "ready", "brief": _brief_out(hit)}
        with _start_lock:
            if not body.regenerate:
                # Re-check under the lock: a run may have finished and saved its brief meanwhile.
                hit = briefs.latest(sid)
                if hit is not None:
                    return {"status": "ready", "brief": _brief_out(hit)}
            rid = _brief_inflight.get(sid)
            if rid:
                raw = runstore.load(rid)
                if raw and raw["state"] not in runstore.TERMINAL:
                    return {"status": "pending", "run_id": rid}
            _capacity(request.state.presenter)
            _spend("brief", request.state.presenter)
            run = runstore.Run.create("brief", None, sid)
            _brief_inflight[sid] = run.id
            _submit(lambda: briefs.run_brief(run, snapshot=snap),
                    on_done=_release_later(_brief_inflight, sid, run.id), run=run)
        return {"status": "pending", "run_id": run.id}

    @app.post("/api/demo/containment")
    def api_containment(body: models.ContainmentIn, request: Request):
        snap = _require_snapshot()
        with _start_lock:
            existing = runstore.find_inflight("containment", None, snap["snapshot_id"])
            if existing:
                return {"run_id": existing}
            _capacity(request.state.presenter)
            _spend("containment", request.state.presenter)
            run = runstore.Run.create("containment", None, snap["snapshot_id"])
            nodes = {n["id"]: n for n in snap["clusters"] + snap["categories"]}
            _submit(lambda: run_containment(run, snapshot_id=snap["snapshot_id"], nodes=nodes,
                                            health=lambda: health_status(fresh=True)["status"], runner=runner()), run=run)
        return {"run_id": run.id}

    @app.get("/api/subthemes")
    def api_subthemes(snapshot_id: str | None = None):
        """Sub-themes inside each leaf of a snapshot (default: the current one). Intake-derived snapshots
        share their base build's leaf ids, so they resolve to that build's sub-themes."""
        sid = snapshot_id if snapshot_id is not None else store.current_id()
        if sid is None or not serializers.SNAPSHOT_ID.match(sid):
            raise ApiError(404, "not_found", "No sub-themes for that snapshot.")
        raw = _subthemes_for(sid)
        if raw is None:
            raise ApiError(404, "not_found", "No sub-themes for that snapshot.")
        return serializers.serialize_subthemes(sid, raw)

    @app.get("/api/eval")
    def api_eval():
        snap_id = store.current_id()
        row = None
        if snap_id:
            row = db.public().execute("SELECT json FROM eval_reports WHERE snapshot_id=? ORDER BY created_at DESC LIMIT 1",
                                      (snap_id,)).fetchone()
        if row is None:
            return err(404, "no_eval_report", "No evaluation report for the current snapshot yet.",
                       snapshot_id=snap_id, generated_at=None, checks=[])
        rep = json.loads(row["json"])
        # Live-run checks (containment, questions) are cheap DB lookups: refresh them on every read so runs
        # made after the report was written (e.g. after a live intake republished the map) are reflected.
        try:
            from ..eval.report import sandbox_checks
            fresh = {c["id"]: c for c in sandbox_checks(snap_id)}
            rep["checks"] = [fresh.pop(c.get("id"), c) for c in rep.get("checks", [])] + list(fresh.values())
        except Exception:  # noqa: BLE001 — the stored report is still valid on its own
            log.warning("eval: live-run check refresh failed")
        return serializers.serialize_eval(rep)

    from .intake import router as intake_router; app.include_router(intake_router)  # noqa: E702 — §11 live intake
    return BodyLimit(app)  # type: ignore[return-value]


app = create_app()
