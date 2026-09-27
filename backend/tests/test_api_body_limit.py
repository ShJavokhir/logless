"""Oversized streamed JSON must be rejected before a side-effecting route executes."""
import asyncio

import pytest
from fastapi import FastAPI

from logless.api.app import BodyLimit, MAX_BODY


@pytest.mark.parametrize("parse_body", [True, False])
def test_streamed_valid_json_prefix_cannot_execute_a_route(parse_body):
    app = FastAPI()
    effects = []

    def write(body: dict):
        effects.append(body)
        return {"ok": True}

    def no_body():
        effects.append("triggered")
        return {"ok": True}

    app.post("/write")(write if parse_body else no_body)

    messages = [
        {"type": "http.request", "body": b'{"intent":"question"}', "more_body": True},
        {"type": "http.request", "body": b" " * MAX_BODY, "more_body": False},
    ]
    sent = []

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "method": "POST", "path": "/write",
             "root_path": "", "scheme": "http", "query_string": b"", "http_version": "1.1",
             "headers": [(b"content-type", b"application/json")], "server": ("test", 80), "client": ("test", 1234)}
    asyncio.run(BodyLimit(app)(scope, receive, send))
    assert sent[0]["status"] == 413
    assert effects == []
