"""Run records (docs/CONTRACTS.md §6 `Run`), persisted as JSON in public.db.runs and updated at
every stage with real timestamps. Only browser-safe fields are ever stored here: no stderr, no
raw sandbox output, no private ids."""
from __future__ import annotations

import json
import threading
from typing import Any

from .. import db
from ..ids import run_id as new_run_id
from ..ids import utcnow

TERMINAL = {"completed", "failed"}
# Initial stage lists. A repair appends another round with the SAME names ("repairing",
# "executing", "validating" for analyses; "writing", "checking" for stories); the UI shows the
# latest started stage of each name.
STAGES: dict[str, list[str]] = {
    "analysis": ["planning", "executing", "validating", "explaining"],
    "story": ["writing", "checking"],
    "prd": ["drafting", "checking"],
    "brief": ["reading", "directing", "checking"],
    "containment": ["runaway", "cleanup", "health", "destructive", "followup", "leak_attempt"],
}
_lock = threading.Lock()


class Run:
    def __init__(self, doc: dict):
        self.doc = doc

    @classmethod
    def create(cls, kind: str, intent: str | None, snapshot_id: str, question: str | None = None) -> "Run":
        """`question` is the already-sanitized echo (question intent only)."""
        now = utcnow()
        names = (["interpreting"] if intent == "question" else []) + STAGES[kind]
        doc = {
            "run_id": new_run_id(), "kind": kind, "intent": intent, "snapshot_id": snapshot_id, "state": "queued",
            "created_at": now, "updated_at": now,
            "stages": [{"name": n, "status": "pending", "started_at": None, "finished_at": None, "detail": None} for n in names],
            "attempts": 0, "code": None, "receipt": None, "verdict": None, "result": None, "explanation": None,
            "containment": None, "error": None, "question": question, "plan": None, "attempts_log": [],
        }
        run = cls(doc)
        run.save(insert=True)
        return run

    @property
    def id(self) -> str:
        return self.doc["run_id"]

    def save(self, insert: bool = False) -> None:
        with _lock:
            self.doc["updated_at"] = utcnow()
            d = self.doc
            con = db.public()
            with db.write(con):
                if insert:
                    con.execute("INSERT INTO runs(run_id, kind, intent, snapshot_id, state, json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                                (d["run_id"], d["kind"], d["intent"], d["snapshot_id"], d["state"], json.dumps(d), d["created_at"], d["updated_at"]))
                else:
                    con.execute("UPDATE runs SET state=?, json=?, updated_at=? WHERE run_id=?",
                                (d["state"], json.dumps(d), d["updated_at"], d["run_id"]))

    def state(self, state: str) -> None:
        self.doc["state"] = state
        self.save()

    def update(self, **fields: Any) -> None:
        for k, v in fields.items():
            if k not in self.doc:
                raise KeyError(k)
            self.doc[k] = v
        self.save()

    def insert_stages(self, names: list[str], before: str | None = None) -> None:
        """Add a new round of pending stages (e.g. a repair) before `before`, or at the end."""
        new = [{"name": n, "status": "pending", "started_at": None, "finished_at": None, "detail": None} for n in names]
        st = self.doc["stages"]
        idx = next((i for i, s in enumerate(st) if s["name"] == before and s["status"] == "pending"), len(st)) if before else len(st)
        st[idx:idx] = new
        self.save()

    def stage(self, name: str, status: str, detail: str | None = None) -> None:
        """Update the earliest still-open (pending/running) stage called `name`, else the latest one."""
        now = utcnow()
        same = [s for s in self.doc["stages"] if s["name"] == name]
        if not same:
            raise KeyError(name)
        open_ = [s for s in same if s["status"] in ("pending", "running")]
        s = open_[0] if open_ else same[-1]
        if status == "running":
            s["started_at"] = now
            s["finished_at"] = None
        elif status in ("done", "failed", "skipped"):
            if s["started_at"] is None and status != "skipped":
                s["started_at"] = now
            s["finished_at"] = now
        s["status"] = status
        if detail is not None:
            s["detail"] = detail
        self.save()

    def skip_pending(self, detail: str | None = None) -> None:
        for s in self.doc["stages"]:
            if s["status"] in ("pending", "running"):
                s["status"] = "skipped" if s["status"] == "pending" else "failed"
                s["finished_at"] = s["finished_at"] or utcnow()
                if detail and s["detail"] is None:
                    s["detail"] = detail
        self.save()

    def fail(self, code: str, message: str) -> None:
        self.doc["error"] = {"code": code, "message": message}
        self.doc["state"] = "failed"
        self.skip_pending()

    def complete(self) -> None:
        self.doc["state"] = "completed"
        self.skip_pending()


def load(run_id: str) -> dict | None:
    row = db.public().execute("SELECT json FROM runs WHERE run_id=?", (run_id,)).fetchone()
    return json.loads(row["json"]) if row else None


def find_inflight(kind: str, intent: str | None, snapshot_id: str) -> str | None:
    row = db.public().execute(
        "SELECT run_id FROM runs WHERE kind=? AND intent IS ? AND snapshot_id=? AND state NOT IN ('completed','failed') "
        "ORDER BY created_at DESC LIMIT 1", (kind, intent, snapshot_id)).fetchone()
    return row["run_id"] if row else None


def fail_interrupted() -> int:
    """At startup: no background work survives a restart, so mark non-terminal runs failed."""
    con = db.public()
    rows = con.execute("SELECT json FROM runs WHERE state NOT IN ('completed','failed')").fetchall()
    for r in rows:
        run = Run(json.loads(r["json"]))
        run.fail("server_restarted", "The server restarted while this run was in progress.")
    return len(rows)
