"""The admission bookkeeping must settle even when execution never starts."""
from concurrent.futures import Future

import pytest

from logless.api import app as api
from logless.sandbox import runs


class RejectedExecutor:
    def submit(self, fn):
        raise RuntimeError("cannot schedule new futures after shutdown")


class QueuedExecutor:
    def __init__(self):
        self.future = Future()

    def submit(self, fn):
        return self.future


def test_scheduler_failure_after_enqueue_cannot_later_execute_rejected_work(tmp_data, monkeypatch):
    class EnqueueThenReject:
        def submit(self, fn):
            self.enqueued = fn
            raise RuntimeError("could not start worker")

    queue = EnqueueThenReject()
    monkeypatch.setattr(api, "executor", queue)
    monkeypatch.setattr(api, "_active", 0)
    effects = []
    run = runs.Run.create("analysis", "question", "snap_20260927T000000_abcd")
    with pytest.raises(api.ApiError):
        api._submit(lambda: effects.append("provider called"), run=run)
    queue.enqueued()  # an existing worker eventually picks up the orphaned item
    assert effects == [] and api._active == 0
    assert runs.load(run.id)["state"] == "failed"


def test_executor_rejection_releases_capacity_and_fails_record(tmp_data, monkeypatch):
    monkeypatch.setattr(api, "executor", RejectedExecutor())
    monkeypatch.setattr(api, "_active", 0)
    released = []
    run = runs.Run.create("analysis", "question", "snap_20260927T000000_abcd")
    with pytest.raises(api.ApiError) as error:
        api._submit(lambda: None, lambda: released.append(True), run=run)
    assert error.value.status == 503
    assert api._active == 0 and released == [True]
    assert runs.load(run.id)["state"] == "failed"


def test_cancelled_queue_entry_releases_capacity_and_fails_record(tmp_data, monkeypatch):
    queue = QueuedExecutor()
    monkeypatch.setattr(api, "executor", queue)
    monkeypatch.setattr(api, "_active", 0)
    released = []
    run = runs.Run.create("analysis", "question", "snap_20260927T000000_abcd")
    api._submit(lambda: pytest.fail("cancelled job must never execute"), lambda: released.append(True), run=run)
    assert api._active == 1
    assert queue.future.cancel()
    assert api._active == 0 and released == [True]
    record = runs.load(run.id)
    assert record["state"] == "failed" and record["error"]["code"] == "server_stopping"


def test_unexpected_worker_exception_is_terminal_and_does_not_echo_private_text(tmp_data, monkeypatch, caplog):
    queue = QueuedExecutor()
    monkeypatch.setattr(api, "executor", queue)
    monkeypatch.setattr(api, "_active", 0)
    run = runs.Run.create("analysis", "question", "snap_20260927T000000_abcd")
    api._submit(lambda: None, run=run)
    queue.future.set_exception(ValueError("private-provider-response"))
    assert api._active == 0
    record = runs.load(run.id)
    assert record["state"] == "failed"
    assert "private-provider-response" not in str(record) + caplog.text


def test_local_settings_load_before_budgets_and_pools(tmp_path):
    import json
    import os
    import subprocess
    import sys
    script = '''
import os, json
from logless import config
for key in ('LOGLESS_BUDGET_SEARCH_PER_HOUR', 'PRESENTER_BUDGET_ANALYSES', 'LOGLESS_SEARCH_CONCURRENCY'):
    os.environ.pop(key, None)
def local_settings(*args, **kwargs):
    os.environ.update(LOGLESS_BUDGET_SEARCH_PER_HOUR='2', PRESENTER_BUDGET_ANALYSES='1', LOGLESS_SEARCH_CONCURRENCY='1')
config.load_dotenv = local_settings
from logless.api import app
print(json.dumps([app.budget.limits['search'], app.presenter_budget.limits['analysis'], app.SEARCH_CONCURRENCY]))
'''
    env = {**os.environ, "LOGLESS_DATA_DIR": str(tmp_path), "VULTR_INFERENCE_API_KEY": "",
           "TYPESAFE_API_KEY": "", "FIREWORKS_API_KEY": ""}
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [2, 1, 1]
