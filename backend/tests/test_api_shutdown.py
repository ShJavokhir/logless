"""Check real executor lock ordering in a killable child, never hang pytest teardown."""
import json
import os
import subprocess
import sys


PROBE = r'''
import json, os, threading
from concurrent.futures import ThreadPoolExecutor
from logless.api import app as api

shutdown_waiting = threading.Event()

class ObservedRLock:
    def __init__(self):
        self.lock = threading.RLock()

    def __enter__(self):
        if threading.current_thread().name == "peer-shutdown":
            shutdown_waiting.set()
        self.lock.acquire()
        return self

    def __exit__(self, *args):
        self.lock.release()

api._start_lock = ObservedRLock()
api._active = 0
pool = api.executor = ThreadPoolExecutor(max_workers=1)
running, worker_release = threading.Event(), threading.Event()

def occupy():
    running.set()
    worker_release.wait()

pool.submit(occupy)
assert running.wait(2)
api._submit(lambda: None, on_done=api._release_later({}, "question", "run"))
request_has_lock, submit_now = threading.Event(), threading.Event()

def request():
    with api._start_lock:
        request_has_lock.set()
        assert submit_now.wait(2)
        try:
            api._submit(lambda: None)
        except api.ApiError:
            pass

request_thread = threading.Thread(target=request, daemon=True)
request_thread.start()
assert request_has_lock.wait(2)
shutdown = api._shutdown_runs if os.environ["PEER_SHUTDOWN_MODE"] == "fixed" else \
    lambda: pool.shutdown(wait=False, cancel_futures=True)
shutdown_thread = threading.Thread(target=shutdown, name="peer-shutdown", daemon=True)
shutdown_thread.start()
# In the fixed version this is the outer lock attempt, before the executor lock.
# In the legacy version it is a cancellation callback, after the executor lock.
assert shutdown_waiting.wait(2)
submit_now.set()
request_thread.join(1)
shutdown_thread.join(1)
result = {"request_finished": not request_thread.is_alive(),
          "shutdown_finished": not shutdown_thread.is_alive(), "active": api._active}
worker_release.set()
print(json.dumps(result), flush=True)
# The deliberately bad legacy mode contains two deadlocked threads. This child owns them.
os._exit(0)
'''


def _probe(tmp_path, mode):
    env = {**os.environ, "LOGLESS_DATA_DIR": str(tmp_path / mode), "PEER_SHUTDOWN_MODE": mode,
           "VULTR_INFERENCE_API_KEY": "", "TYPESAFE_API_KEY": "", "FIREWORKS_API_KEY": ""}
    result = subprocess.run([sys.executable, "-c", PROBE], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_shutdown_finishes_during_concurrent_request_admission(tmp_path):
    assert _probe(tmp_path, "fixed") == {"request_finished": True, "shutdown_finished": True, "active": 0}


def test_probe_reproduces_legacy_shutdown_lock_inversion(tmp_path):
    result = _probe(tmp_path, "legacy")
    assert not result["request_finished"] and not result["shutdown_finished"]
