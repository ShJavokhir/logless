"""Runner HTTP API (docs/CONTRACTS.md §9). Private VPC address only; bearer-token auth.

Error bodies are {code, message}; no stack traces, no request bodies in logs."""
from __future__ import annotations

import hmac
import logging
import re
import sys
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config
from .supervisor import ALLOWED_INPUTS, JobConflict, JobSpec, Quarantined, QueueFull, Supervisor

log = logging.getLogger("logless.runner")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")


class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str
    kind: Literal["analysis", "aggregate", "containment"]
    code: str
    files: dict[str, str] = Field(default_factory=dict)
    timeout_s: float = Field(gt=0)
    memory_mb: int = 512

    @field_validator("job_id")
    @classmethod
    def _uuid(cls, v: str) -> str:
        try:
            return str(uuid.UUID(v))
        except ValueError as e:
            raise ValueError("job_id must be a UUID") from e

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("code is empty")
        if len(v.encode()) > config.MAX_CODE_BYTES:
            raise ValueError("code exceeds 64 KiB")
        return v

    @field_validator("files")
    @classmethod
    def _files(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > config.MAX_FILES:
            raise ValueError("too many files")
        total = 0
        for name, content in v.items():
            if not NAME_RE.match(name) or name not in ALLOWED_INPUTS:
                raise ValueError("file name not allowed")
            total += len(content.encode())
        if total > config.MAX_FILES_BYTES:
            raise ValueError("files exceed 8 MiB")
        return v

    @field_validator("timeout_s")
    @classmethod
    def _timeout(cls, v: float) -> float:
        if not (config.MIN_TIMEOUT_S <= v <= config.MAX_TIMEOUT_S):
            raise ValueError("timeout_s must be within 0.5..10")
        return float(v)

    @field_validator("memory_mb")
    @classmethod
    def _memory(cls, v: int) -> int:
        if not (config.MIN_MEMORY_MB <= v <= config.MAX_MEMORY_MB):
            raise ValueError("memory_mb must be within 128..512")
        return v


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status)


class BodyLimit:
    """ASGI middleware: reject request bodies above MAX_REQUEST_BYTES (declared or streamed)."""

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers", []):
            if k == b"content-length":
                if not v.isdigit():
                    return await _err(400, "bad_request", "bad content-length")(scope, receive, send)
                if int(v) > self.limit:
                    return await _err(413, "payload_too_large", "request body too large")(scope, receive, send)
        seen = 0
        too_big = False
        started = False

        async def limited():
            nonlocal seen, too_big
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.limit:
                    too_big = True  # stop reading; the app sees an empty, final chunk
                    return {"type": "http.request", "body": b"", "more_body": False}
            return msg

        async def guarded_send(message):
            nonlocal started
            if too_big:
                if not started:
                    started = True
                    await _err(413, "payload_too_large", "request body too large")(scope, receive, send)
                return
            started = True
            await send(message)

        await self.app(scope, limited, guarded_send)


class BearerAuth:
    """ASGI middleware: every /jobs request must carry the bearer token. Checked on the headers
    alone, before any of the body is read, so unauthenticated callers cannot make the runner
    buffer or parse anything."""

    def __init__(self, app, token: bytes):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and (scope.get("path") == "/jobs" or scope.get("path", "").startswith("/jobs/")):
            auth = b""
            for k, v in scope.get("headers", []):
                if k == b"authorization":
                    auth = v
                    break
            if not (auth.startswith(b"Bearer ") and hmac.compare_digest(auth[7:].strip(), self.token)):
                return await _err(401, "unauthorized", "missing or invalid bearer token")(scope, receive, send)
        return await self.app(scope, receive, send)


def create_app(settings: config.Settings | None = None, supervisor: Supervisor | None = None) -> FastAPI:
    s = settings or config.load()
    if not s.token:
        raise RuntimeError("RUNNER_TOKEN is not set; refusing to start")
    sup = supervisor or Supervisor(s)
    token = s.token.encode()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        sup.start()
        yield
        sup.stop()

    app = FastAPI(title="logless-runner", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.supervisor = sup

    def require_token(request: Request) -> None:
        """Runs before body parsing, so unauthenticated callers learn nothing about validation."""
        h = request.headers.get("authorization", "")
        if not (h.startswith("Bearer ") and hmac.compare_digest(h[7:].strip().encode(), token)):
            raise StarletteHTTPException(status_code=401, detail="missing or invalid bearer token")

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        # Never echo input values: report only the failing field path and a fixed reason.
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", ())[1:]) or "body"
        reason = str(first.get("ctx", {}).get("error", "")) or first.get("type", "invalid")
        return _err(422, "invalid_request", f"{loc}: {reason}"[:200])

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        code = {401: "unauthorized", 404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _err(exc.status_code, code, str(exc.detail)[:200])

    @app.exception_handler(Exception)
    async def _any(_: Request, exc: Exception):
        log.error("unhandled %s", type(exc).__name__)
        return _err(500, "internal_error", "internal error")

    @app.get("/health")
    def health():
        return sup.health()

    @app.post("/jobs", status_code=202, dependencies=[Depends(require_token)])
    def submit(job: JobIn):
        spec = JobSpec(job_id=job.job_id, kind=job.kind, code=job.code, files=dict(job.files),
                       timeout_s=job.timeout_s, memory_mb=job.memory_mb)
        try:
            rec, created = sup.submit(spec)
        except JobConflict:
            return _err(409, "job_conflict", "job_id already used for a different job")
        except QueueFull:
            return _err(503, "busy", "runner queue is full")
        except Quarantined:
            return _err(503, "quarantined", "a previous container is not yet verified as removed; retry shortly")
        if created:
            log.info("job %s kind=%s queued", spec.job_id, spec.kind)
        return JSONResponse({"job_id": spec.job_id, "state": rec.view()["state"]}, status_code=202)

    @app.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
    def get_job(job_id: str):
        try:
            job_id = str(uuid.UUID(job_id))
        except ValueError:
            return _err(404, "not_found", "unknown job")
        rec = sup.get(job_id)
        if rec is None:
            return _err(404, "not_found", "unknown job")
        return rec.view()

    # Order: auth first (headers only), then the body limit, then the app.
    return BearerAuth(BodyLimit(app, config.MAX_REQUEST_BYTES), token)  # type: ignore[return-value]


def main() -> int:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = config.load()
    if not s.token:
        print("RUNNER_TOKEN is not set; refusing to start", file=sys.stderr)
        return 2
    uvicorn.run(create_app(s), host=s.host, port=s.port, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
