#!/usr/bin/env python3
"""Smoke-test logless using only the standard library (Python 3.10+).

Live free checks: ./scripts/smoke_live.py --skip-paid
Offline regression tests: ./scripts/smoke_live.py --self-test
Omitting --skip-paid spends analysis/story/containment budget.
"""

import argparse
import http.client
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_URL = "https://144-202-110-2.sslip.io"
DEFAULT_QUESTION = "Which coding workflows have the most distinct people repeating requests?"
UNSUPPORTED_QUESTION = "Show me the conversations about divorce"
BUDGET_CODES = {"budget_exhausted", "rate_limited"}
PRIVATE_ID = re.compile(r"\b(?:c_[0-9a-f]{12}|u_[0-9a-f]{10})\b")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL = re.compile(r"\b(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>\"']+", re.I)
MARKER = re.compile(r"\[([np]\d+)\]")


class CheckFailed(Exception):
    """A concise, safe diagnostic, never a raw response body."""


class BudgetSkipped(Exception):
    pass


def require(condition, detail):
    if not condition:
        raise CheckFailed(detail)


def mapping(value):
    return value if isinstance(value, dict) else {}


def items(value, label):
    require(isinstance(value, list), f"{label} must be a list")
    return value


def number(value):
    return (type(value) is int and value >= 0
            or type(value) is float and math.isfinite(value) and value >= 0)


def error_code(payload):
    code = mapping(payload).get("code")
    return code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code) else "unknown_error"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Do not forward a presenter credential to a redirect destination.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base_url, presenter_key=""):
        self.base_url = base_url.rstrip("/")
        self.presenter_key = presenter_key
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None, deadline=None):
        remaining = 15.0 if deadline is None else deadline - time.monotonic()
        require(remaining > 0, "run timeout exceeded")
        headers = {"Accept": "application/json", "User-Agent": "logless-smoke/1"}
        if self.presenter_key:
            headers["X-Logless-Presenter"] = self.presenter_key
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            try:
                response = self.opener.open(request, timeout=min(15.0, remaining))
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                status = response.code
                raw = response.read(8 * 1024 * 1024 + 1)
            require(len(raw) <= 8 * 1024 * 1024, "response exceeds 8 MiB")
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeError):
                raise CheckFailed(f"HTTP {status}: response is not valid JSON") from None
            code = error_code(payload)
            if status == 429 and code in BUDGET_CODES:
                raise BudgetSkipped(code)
            require(status == 200, f"HTTP {status}: {code}")
            require(isinstance(payload, dict), "response must be a JSON object")
            if deadline is not None:
                require(time.monotonic() <= deadline, "run timeout exceeded")
            return payload
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
            # Exceptions can include request data; print only their class.
            cause = getattr(exc, "reason", None)
            label = type(exc).__name__
            if isinstance(cause, Exception):
                label += f"/{type(cause).__name__}"
            raise CheckFailed(f"request failed ({label})") from None


def scan_snapshot(payload):
    """Inspect values AND keys; dataset URLs are the only URL exemption."""
    allowed_urls = set()
    dataset = mapping(payload.get("dataset"))
    for key in ("source_url", "dataset_url", "url", "source_urls", "dataset_urls"):
        values = dataset.get(key)
        values = values if isinstance(values, list) else [values]
        for value in values:
            if isinstance(value, str) and URL.fullmatch(value):
                allowed_urls.add(value)

    def visit(value, in_dataset=False):
        if isinstance(value, str):
            require(not PRIVATE_ID.search(value), "snapshot contains a private id (value redacted)")
            require(not EMAIL.search(value), "snapshot contains an email (value redacted)")
            for match in URL.finditer(value):
                require(in_dataset and (match.group() in allowed_urls or match.group().rstrip(".,;)") in allowed_urls),
                        "snapshot contains a non-dataset URL (value redacted)")
        elif isinstance(value, list):
            for child in value:
                visit(child, in_dataset)
        elif isinstance(value, dict):
            for key, child in value.items():
                visit(key, in_dataset)
                visit(child, in_dataset)

    for key, value in payload.items():
        visit(key)
        visit(value, key == "dataset")


class SmokeTest:
    def __init__(self, client, question=DEFAULT_QUESTION, timeout=90.0, skip_paid=False):
        self.client = client
        self.question = question
        self.timeout = timeout
        self.skip_paid = skip_paid
        self.snapshot = None
        self.version = "unknown"
        self.version_evidence = "no snapshot or analysis evidence"
        self.version_confirmed = False
        self.checks = []

    def snapshot_required(self):
        require(self.snapshot is not None, "requires a passing snapshot check")
        return self.snapshot

    def health(self):
        data = self.client.request("/api/health")
        require(data.get("status") == "ok", "health status is not ok")
        require(data.get("sandbox") == "reachable", "sandbox is not reachable")
        return "status ok; sandbox reachable", {}

    def check_snapshot(self):
        data = self.client.request("/api/snapshot")
        scan_snapshot(data)
        require(isinstance(data.get("snapshot_id"), str) and data["snapshot_id"], "snapshot_id missing")
        categories = items(data.get("categories"), "categories")
        leaves = items(data.get("clusters"), "clusters")
        require(categories and leaves, "snapshot has no categories or leaves")
        category_ids = [mapping(node).get("id") for node in categories]
        leaf_ids = [mapping(node).get("id") for node in leaves]
        for ids, label in ((category_ids, "category"), (leaf_ids, "leaf")):
            require(all(isinstance(value, str) and value for value in ids), f"invalid {label} id")
            require(len(set(ids)) == len(ids), f"duplicate {label} ids")
        total = mapping(data.get("totals")).get("conversations")
        require(type(total) is int and total >= 0, "invalid totals.conversations")
        summed = 0
        for node in leaves:
            require(node.get("parent_id") in category_ids, "leaf lacks an existing parent category")
            count = node.get("conversations")
            require(type(count) is int and count >= 0, "invalid leaf conversations")
            summed += count
        require(summed == total, f"leaf sum {summed} != totals.conversations {total}")
        self.snapshot = data
        provenance = data.get("provenance")
        if isinstance(provenance, dict):
            legacy = "stats_source" in provenance
            self.version = "legacy" if legacy else "question-only"
            self.version_evidence = "snapshot provenance.stats_source " + ("present" if legacy else "absent")
        return f"{len(leaves)} leaves; {summed} conversations; parents and privacy checks passed", {
            "leaves": len(leaves), "conversations": summed,
        }

    def evaluation(self):
        snapshot = self.snapshot_required()
        data = self.client.request("/api/eval")
        require(data.get("snapshot_id") == snapshot["snapshot_id"], "eval report is for a different snapshot")
        checks = items(data.get("checks"), "eval checks")
        require(checks, "eval report has no checks")
        require(all(isinstance(check, dict) for check in checks), "invalid eval check")
        # Null means informational/unscored, not an unmet target.
        scored = [check for check in checks if check.get("passed") is not None]
        met = sum(check.get("passed") is True for check in scored)
        return f"current snapshot report; {met} of {len(scored)} targets met", {
            "targets_met": met, "targets": len(scored), "informational_checks": len(checks) - len(scored),
        }

    def search(self):
        snapshot = self.snapshot_required()
        data = self.client.request("/api/search", {"query": self.question, "snapshot_id": snapshot["snapshot_id"]})
        require(data.get("snapshot_id") == snapshot["snapshot_id"], "search snapshot does not match")
        results = items(data.get("results"), "search results")
        leaf_ids = {node["id"] for node in snapshot["clusters"]}
        require(all(isinstance(row, dict) and isinstance(row.get("cluster_id"), str)
                    and row["cluster_id"] in leaf_ids for row in results), "search references an unknown leaf")
        return f"HTTP 200; {len(results)} results reference existing leaves", {"results": len(results)}

    def poll(self, run_id, deadline):
        require(isinstance(run_id, str) and re.fullmatch(r"run_[A-Za-z0-9_-]+", run_id), "missing or invalid run_id")
        while True:
            data = self.client.request("/api/runs/" + run_id, deadline=deadline)
            if data.get("state") in ("completed", "failed"):
                code = error_code(mapping(data.get("error")))
                if data.get("state") == "failed" and code in BUDGET_CODES:
                    raise BudgetSkipped(code)
                return data
            require(data.get("state") in {"queued", "planning", "executing", "validating", "repairing", "explaining"},
                    "run has missing or unknown state")
            remaining = deadline - time.monotonic()
            require(remaining > 0, "run timeout exceeded")
            time.sleep(min(1.0, remaining))

    def start_run(self, path, body, deadline):
        data = self.client.request(path, body, deadline)
        return self.poll(data.get("run_id"), deadline)

    def require_completed(self, run):
        require(run.get("state") == "completed", f"run failed: {error_code(mapping(run.get('error')))}")

    def detect_run_version(self, log):
        if any("program" in attempt for attempt in log):
            self.version = "question-only"
            self.version_evidence = "analysis attempts_log contains program labels"
            self.version_confirmed = True
        elif log:
            # The previous API supports questions too, but has one unlabeled program.
            self.version = "legacy"
            self.version_evidence = "analysis attempts_log has no program labels"
            self.version_confirmed = True

    def analysis(self):
        snapshot = self.snapshot_required()
        started = time.monotonic()
        run = self.start_run("/api/analyses", {
            "intent": "question", "question": self.question, "snapshot_id": snapshot["snapshot_id"],
        }, started + self.timeout)
        log = items(run.get("attempts_log") or [], "attempts_log")
        require(all(isinstance(attempt, dict) for attempt in log), "invalid attempt entry")
        self.detect_run_version(log)
        self.require_completed(run)
        verdict = mapping(run.get("verdict"))
        require(verdict.get("passed") is True, "analysis verdict did not pass")
        result = mapping(run.get("result"))
        rows = items(result.get("rows"), "result rows")
        require(rows and all(isinstance(row, dict) and row for row in rows), "analysis has no result rows")
        gate_checks = items(verdict.get("checks") or [], "gate checks")
        sandbox_ms = {}
        if self.version == "question-only":
            for program in ("A", "B"):
                attempts = [attempt for attempt in log if attempt.get("program") == program]
                require(attempts, f"program {program} missing from attempts_log")
                receipts = [mapping(attempt.get("receipt")) for attempt in attempts if attempt.get("receipt") is not None]
                require(receipts and mapping(attempts[-1].get("receipt")), f"program {program} has no execution receipt")
                require(all(receipt.get("runtime") == "runsc" for receipt in receipts), f"program {program} runtime is not runsc")
                require(all(number(receipt.get("elapsed_ms")) for receipt in receipts), f"program {program} sandbox timing missing")
                sandbox_ms[program] = sum(receipt["elapsed_ms"] for receipt in receipts)
        else:
            receipts = [mapping(attempt.get("receipt")) for attempt in log if attempt.get("receipt") is not None]
            if not receipts and run.get("receipt") is not None:
                receipts = [mapping(run["receipt"])]
            require(receipts, "analysis has no sandbox execution receipt")
            require(all(receipt.get("runtime") == "runsc" for receipt in receipts), "legacy analysis runtime is not runsc")
            timings = [receipt.get("elapsed_ms") for receipt in receipts]
            sandbox_ms["legacy"] = sum(timings) if all(number(value) for value in timings) else None
        elapsed = time.monotonic() - started
        timing = ", ".join(f"{program}={value:g} ms" if value is not None else f"{program}=unavailable"
                           for program, value in sandbox_ms.items())
        return f"{self.version}; completed in {elapsed:.2f}s; sandbox {timing}; {len(gate_checks)} gate checks; {len(rows)} rows", {
            "sandbox_ms": sandbox_ms, "gate_checks": len(gate_checks), "rows": len(rows),
        }

    def unsupported(self):
        snapshot = self.snapshot_required()
        run = self.start_run("/api/analyses", {
            "intent": "question", "question": UNSUPPORTED_QUESTION, "snapshot_id": snapshot["snapshot_id"],
        }, time.monotonic() + self.timeout)
        code = error_code(mapping(run.get("error")))
        require(run.get("state") == "failed" and code == "unsupported_question",
                f"expected failed/unsupported_question, got {code}")
        require(run.get("receipt") is None, "unsupported question has a sandbox receipt")
        require(run.get("attempts") in (None, 0), "unsupported question executed attempts")
        require(not run.get("attempts_log"), "unsupported question has attempt history")
        return "unsupported_question; no receipt or attempts executed", {}

    def containment(self):
        run = self.start_run("/api/demo/containment", {}, time.monotonic() + self.timeout)
        self.require_completed(run)
        data = mapping(run.get("containment"))
        for field in ("killed", "container_removed", "leak_attempt_rejected"):
            require(data.get(field) is True, f"containment.{field} is not true")
        require(data.get("app_health") == "ok", "containment app_health is not ok")
        require(number(data.get("elapsed_ms")) and number(data.get("deadline_ms")), "containment timings missing")
        return f"killed and removed; health ok; leak rejected; {data['elapsed_ms']:g} ms vs deadline {data['deadline_ms']:g} ms", {
            "elapsed_ms": data["elapsed_ms"], "deadline_ms": data["deadline_ms"],
        }

    def story(self):
        snapshot = self.snapshot_required()
        other_categories = {node["id"] for node in snapshot["categories"] if node.get("is_other") or node.get("title", "").lower() == "other"}
        leaves = [node for node in snapshot["clusters"] if node["id"] != "cl_other" and not node.get("is_other")
                  and node.get("parent_id") not in other_categories]
        require(leaves, "no non-Other leaf for story")
        node = sorted(leaves, key=lambda leaf: (-leaf["conversations"], leaf["id"]))[0]
        path = "/api/clusters/" + urllib.parse.quote(node["id"], safe="") + "/story"
        deadline = time.monotonic() + self.timeout
        body = {"snapshot_id": snapshot["snapshot_id"]}
        last_poll_finished = 0
        while True:
            data = self.client.request(path, body, deadline)
            if data.get("status") == "ready":
                break
            require(data.get("status") == "pending", "story status is neither ready nor pending")
            remaining = deadline - time.monotonic()
            require(remaining > 0, "run timeout exceeded")
            delay = 1.0 - (time.monotonic() - last_poll_finished)
            if delay > 0:
                time.sleep(min(delay, remaining))
            self.require_completed(self.poll(data.get("run_id"), deadline))
            last_poll_finished = time.monotonic()
            # Completed stories are fetched immediately by the cached POST (§6).
        story = mapping(data.get("story"))
        require(story.get("cluster_id") == node["id"], "story belongs to another cluster")
        require(story.get("snapshot_id") == snapshot["snapshot_id"], "story belongs to another snapshot")
        text = story.get("text")
        require(isinstance(text, str), "story text missing")
        # Match the backend's word counter, excluding inline [n1]/[p1] citations.
        words = len(re.findall(r"[A-Za-zÀ-ÿ'’-]+", MARKER.sub("", text)))
        require(90 <= words <= 140, f"story has {words} words; expected 90–140")
        evidence = {mapping(item).get("id") for field in ("needs", "problems") for item in (node.get(field) or [])}
        citations = items(story.get("citations"), "story citations")
        require(all(isinstance(citation, str) and citation in evidence for citation in citations), "story citations reference unknown evidence")
        require(set(MARKER.findall(text)) <= evidence, "story inline citations reference unknown evidence")
        return f"largest non-Other leaf; ready; {words} words; {len(citations)} valid citations", {
            "cluster_id": node["id"], "words": words, "citations": len(citations),
        }

    def run(self, emit=None):
        steps = (("health", self.health), ("snapshot", self.check_snapshot), ("eval", self.evaluation),
                 ("search", self.search), ("question", self.analysis), ("unsupported_question", self.unsupported),
                 ("containment", self.containment), ("story", self.story))
        for index, (name, check) in enumerate(steps, 1):
            started = time.monotonic()
            record = {"check": index, "name": name, "status": "PASS", "detail": "", "metrics": {}}
            try:
                if self.skip_paid and index >= 5:
                    record.update(status="SKIPPED", detail="--skip-paid", reason="skip_paid")
                else:
                    record["detail"], record["metrics"] = check()
            except BudgetSkipped as exc:
                record.update(status="SKIPPED", detail=str(exc), reason="budget")
            except CheckFailed as exc:
                record.update(status="FAIL", detail=str(exc))
            except (KeyError, TypeError, ValueError, AttributeError, RecursionError) as exc:
                record.update(status="FAIL", detail=f"malformed response ({type(exc).__name__})")
            record["elapsed_s"] = round(time.monotonic() - started, 3)
            self.checks.append(record)
            if emit:
                emit(record)
        counts = {status.lower(): sum(record["status"] == status for record in self.checks)
                  for status in ("PASS", "FAIL", "SKIPPED")}
        return {"base_url": self.client.base_url, "api_version": self.version,
                "api_version_confirmed": self.version_confirmed, "api_version_evidence": self.version_evidence,
                "checks": self.checks, "counts": counts, "exit_code": int(counts["fail"] > 0)}


def self_test():
    """Real local HTTP tests; never contact the live host or a model provider."""
    import contextlib
    import copy
    import email.message
    import http.server
    import io
    import threading

    snapshot = {
        "snapshot_id": "snap_test", "totals": {"conversations": 20},
        "dataset": {"source_url": "https://huggingface.co/datasets/allenai/WildChat-1M"},
        "categories": [{"id": "cat_coding"}, {"id": "cat_other", "is_other": True}],
        "clusters": [
            {"id": "cl_small", "parent_id": "cat_coding", "conversations": 3, "needs": None},
            {"id": "cl_large", "parent_id": "cat_coding", "conversations": 7, "needs": [{"id": "n1"}], "problems": None},
            {"id": "cl_other", "parent_id": "cat_other", "conversations": 10},
        ], "provenance": {},
    }
    receipt = {"runtime": "runsc", "elapsed_ms": 12}
    gate = {"passed": True, "checks": [{"name": "Schema matches exactly", "passed": True}]}
    scenario = {"version": "new", "mode": "normal", "requests": [], "polls": {}}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            scenario["requests"].append((self.command, self.path, body, self.headers.get("X-Logless-Presenter")))
            status, response = 200, {}
            mode = scenario["mode"]
            if self.path == "/api/health":
                response = {"status": "ok", "sandbox": "reachable"}
            elif self.path == "/api/snapshot":
                response = copy.deepcopy(snapshot)
                if scenario["version"] == "legacy":
                    response["provenance"]["stats_source"] = "sandbox"
                if mode == "missing_optional":
                    response.pop("provenance")
                if mode == "leak":
                    response["dataset"]["note"] = "c_0123456789ab"
            elif self.path == "/api/eval":
                response = {"snapshot_id": "snap_test", "checks": [{"passed": True}, {"passed": False}, {"passed": None}]}
                if mode == "stale_eval":
                    response["snapshot_id"] = "snap_old"
            elif self.path == "/api/search":
                response = {"snapshot_id": "snap_test", "results": [{"cluster_id": "cl_small"}]}
                if mode in BUDGET_CODES:
                    status, response = 429, {"code": mode, "message": "secret-presenter-key"}
                elif mode == "bad_search":
                    response["results"] = [{"cluster_id": "cl_missing"}]
            elif self.path == "/api/analyses":
                run_id = "run_unsupported" if body.get("question") == UNSUPPORTED_QUESTION else "run_question"
                response = {"run_id": run_id}
                if mode == "paid_budget":
                    status, response = 429, {"code": "budget_exhausted"}
            elif self.path == "/api/demo/containment":
                response = {"run_id": "run_containment"}
            elif self.path == "/api/clusters/cl_large/story":
                if "run_story" in scenario["polls"] or mode == "ready_story":
                    response = {"status": "ready", "story": {
                        "cluster_id": "cl_large", "snapshot_id": "snap_test", "text": " ".join(["workflow"] * 100) + " [n1]",
                        "citations": ["n1"],
                    }}
                    if mode == "bad_citation":
                        response["story"]["citations"] = ["n99"]
                else:
                    response = {"status": "pending", "run_id": "run_story"}
            elif self.path.startswith("/api/runs/"):
                run_id = self.path.rsplit("/", 1)[-1]
                polls = scenario["polls"].get(run_id, 0)
                scenario["polls"][run_id] = polls + 1
                response = {"state": "completed", "run_id": run_id}
                if run_id == "run_question":
                    log = [{"attempt": 1, "receipt": receipt, "verdict": gate}]
                    if scenario["version"] == "new":
                        log = [dict(log[0], program=program) for program in ("A", "B")]
                    response.update(verdict=gate, result={"rows": [{"id": "cl_large", "count": 1}]}, receipt=receipt, attempts_log=log)
                    if mode == "missing_b":
                        response["attempts_log"] = log[:1]
                    elif mode == "wrong_runtime":
                        response["attempts_log"] = [dict(attempt, receipt={"runtime": "runc", "elapsed_ms": 1}) for attempt in log]
                    elif mode == "missing_optional":
                        response.pop("attempts_log")
                    elif mode == "interpretation_failed":
                        response.update(state="failed", error={"code": "interpretation_failed"}, attempts_log=None)
                    elif mode == "repair":
                        response["attempts_log"] = [dict(log[0], receipt=None, verdict={"passed": False})] + log
                    elif mode == "null_result":
                        response.update(result=None, verdict=None)
                elif run_id == "run_unsupported":
                    response.update(state="failed", error={"code": "unsupported_question"})
                    if mode == "unsupported_executed":
                        response["attempts"] = 1
                elif run_id == "run_containment":
                    response["containment"] = {"killed": True, "container_removed": True, "app_health": "ok",
                                               "leak_attempt_rejected": True, "elapsed_ms": 501, "deadline_ms": 500}
                    if mode == "bad_containment":
                        response["containment"]["killed"] = False
                if (mode == "pending" and polls == 0) or mode == "timeout":
                    response = {"state": "queued"}
            else:
                status, response = 404, {"code": "not_found"}
            encoded = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    cases = 0
    server = None
    original_build_opener = urllib.request.build_opener
    transport = "localhost HTTP server"
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    except PermissionError:
        # Some coding sandboxes forbid even loopback binds. Exercise the SAME
        # http.server handler with serialized HTTP in memory, without sockets.
        transport = "in-memory HTTP handler (loopback bind denied)"

        class MemorySocket:
            def __init__(self, raw):
                self.input = io.BytesIO(raw)
                self.output = io.BytesIO()

            def makefile(self, *args):
                return self.input

            def sendall(self, data):
                self.output.write(data)

        class MemoryOpener:
            def open(self, request, timeout):
                body = request.data or b""
                headers = dict(request.header_items())
                headers["Content-Length"] = str(len(body))
                raw = (f"{request.get_method()} {request.selector} HTTP/1.0\r\n"
                       + "".join(f"{key}: {value}\r\n" for key, value in headers.items()) + "\r\n").encode() + body
                connection = MemorySocket(raw)
                Handler(connection, ("127.0.0.1", 0), None)
                head, body = connection.output.getvalue().split(b"\r\n\r\n", 1)
                code = int(head.split(b" ", 2)[1])
                return urllib.response.addinfourl(io.BytesIO(body), email.message.Message(), request.full_url, code)

        urllib.request.build_opener = lambda *args: MemoryOpener()
        base_url = "http://127.0.0.1:1"
    if server is not None:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        for version in ("new", "legacy"):
            for mode, failures in (("normal", set()), ("pending", set()), ("ready_story", set()), ("repair", set()),
                                   ("wrong_runtime", {"question"}), ("bad_citation", {"story"}),
                                   ("interpretation_failed", {"question"}), ("null_result", {"question"}),
                                   ("unsupported_executed", {"unsupported_question"}), ("bad_containment", {"containment"}),
                                   ("paid_budget", set()), ("missing_optional", set())):
                scenario.update(version=version, mode=mode, requests=[], polls={})
                summary = SmokeTest(Client(base_url, "secret-presenter-key"), timeout=10).run()
                actual = {check["name"] for check in summary["checks"] if check["status"] == "FAIL"}
                assert actual == failures, (version, mode, summary)
                assert summary["exit_code"] == bool(failures)
                if mode in ("normal", "pending", "repair"):
                    assert summary["api_version"] == ("question-only" if version == "new" else "legacy")
                    assert summary["api_version_confirmed"]
                if mode == "paid_budget":
                    assert [check["reason"] for check in summary["checks"] if check["status"] == "SKIPPED"] == ["budget", "budget"]
                assert all(request[3] == "secret-presenter-key" for request in scenario["requests"])
                assert "secret-presenter-key" not in json.dumps(summary)
                assert sum(request[1] == "/api/search" for request in scenario["requests"]) == 1
                cases += 1
        scenario.update(version="new", mode="missing_b", requests=[], polls={})
        summary = SmokeTest(Client(base_url), timeout=10).run()
        assert summary["checks"][4]["status"] == "FAIL"
        cases += 1
        for mode in ("normal", "budget_exhausted", "rate_limited", "bad_search", "stale_eval", "leak"):
            scenario.update(version="legacy", mode=mode, requests=[], polls={})
            summary = SmokeTest(Client(base_url), skip_paid=True).run()
            assert all(method == "GET" or path == "/api/search" for method, path, _, _ in scenario["requests"])
            assert sum(path == "/api/search" for _, path, _, _ in scenario["requests"]) <= 1
            assert all(check["status"] == "SKIPPED" for check in summary["checks"][4:])
            assert summary["exit_code"] == (mode in {"bad_search", "stale_eval", "leak"})
            if mode in BUDGET_CODES:
                assert summary["checks"][3]["reason"] == "budget"
            cases += 1
        scenario.update(version="new", mode="timeout", requests=[], polls={})
        summary = SmokeTest(Client(base_url), timeout=0.03).run()
        assert all(check["status"] == "FAIL" for check in summary["checks"][4:])
        cases += 1
        # Exercise actual CLI formatting and exit code; no live URL is involved.
        for json_mode in (False, True):
            scenario.update(version="legacy", mode="normal", requests=[], polls={})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["--base-url", base_url, "--skip-paid"] + (["--json"] if json_mode else []))
            assert code == 0
            if json_mode:
                assert json.loads(output.getvalue())["counts"] == {"pass": 4, "fail": 0, "skipped": 4}
            else:
                assert "PASS 1. health" in output.getvalue() and "SKIPPED 5. question" in output.getvalue()
            cases += 1
        for value in ("c_0123456789ab", "u_0123456789", "person@example.com", "https://example.com", "www.example.com"):
            for location in ("value", "key", "dataset"):
                payload = copy.deepcopy(snapshot)
                if location == "key":
                    payload[value] = "innocent"
                elif location == "dataset":
                    payload["dataset"]["note"] = value
                else:
                    payload["clusters"][0]["nested"] = [{"text": value}]
                try:
                    scan_snapshot(payload)
                except CheckFailed:
                    pass
                else:
                    raise AssertionError((location, value))
                cases += 1
    finally:
        urllib.request.build_opener = original_build_opener
        if server is not None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    return {"self_test": "PASS", "cases": cases, "api_versions": ["question-only", "legacy"],
            "live_requests": 0, "transport": transport}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=DEFAULT_URL)
    parser.add_argument("--presenter-key-env", metavar="NAME", help="environment variable containing the presenter key (never printed)")
    parser.add_argument("--skip-paid", action="store_true", help="only free GETs and at most one search")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--timeout", type=float, default=90, metavar="SECONDS", help="deadline per run, including submission/polling (default: 90)")
    parser.add_argument("--json", action="store_true", help="emit only a machine-readable JSON summary")
    parser.add_argument("--self-test", action="store_true", help="test both API versions with a local fake HTTP server; no live requests")
    args = parser.parse_args(argv)
    if args.self_test:
        result = self_test()
        print(json.dumps(result) if args.json else f"PASS self-test: {result['cases']} cases; both API versions; zero live requests; {result['transport']}")
        return 0
    try:
        parsed = urllib.parse.urlsplit(args.base_url)
    except ValueError:
        parser.error("--base-url must be a valid HTTP(S) URL")
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("--base-url must be an HTTP(S) URL without credentials, query, or fragment")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be a positive, finite number")
    if not args.question.strip() or len(args.question) > 200:
        parser.error("--question must contain 1–200 characters")
    key = os.environ.get(args.presenter_key_env, "") if args.presenter_key_env else ""

    def safe(text):
        return text.replace(key, "[redacted]") if key else text

    def emit(record):
        detail = " ".join(record["detail"].split())
        status = "SKIPPED: budget" if record.get("reason") == "budget" else record["status"]
        print(safe(f"{status} {record['check']}. {record['name']}: {detail} ({record['elapsed_s']:.2f}s)"), flush=True)

    summary = SmokeTest(Client(args.base_url, key), args.question, args.timeout, args.skip_paid).run(None if args.json else emit)
    if args.json:
        def redact(value):
            if isinstance(value, str):
                return safe(value)
            if isinstance(value, list):
                return [redact(item) for item in value]
            if isinstance(value, dict):
                return {field: redact(item) for field, item in value.items()}
            return value

        print(json.dumps(redact(summary), indent=2, ensure_ascii=False))
    else:
        confidence = "confirmed by run" if summary["api_version_confirmed"] else "unconfirmed by run"
        print(safe(f"API: {summary['api_version']} ({summary['api_version_evidence']}; {confidence})"))
        counts = summary["counts"]
        print(f"Summary: {counts['pass']} PASS, {counts['fail']} FAIL, {counts['skipped']} SKIPPED")
    return summary["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
