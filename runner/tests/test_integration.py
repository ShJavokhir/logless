"""Opt-in integration tests on a dedicated Docker test daemon/VM only.

RUNNER_INTEGRATION=1 is required before any Docker probe. Existing logless.job containers or
uncertain inventory cause a skip. Never share this daemon with a production or concurrent runner:
the preflight empty check cannot prevent another process from submitting work afterward, and
Supervisor.start() reaps labelled containers. Runtime: RUNNER_IT_RUNTIME (default runc).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from logless_runner import config
from logless_runner.docker import Docker
from logless_runner.supervisor import JobSpec, Supervisor

IMAGE = os.environ.get("RUNNER_IMAGE", "logless-analysis:1")
RUNTIME = os.environ.get("RUNNER_IT_RUNTIME", "runc")


def integration_docker() -> Docker:
    """Fail closed before constructing a supervisor; return the same probed daemon adapter."""
    if os.environ.get("RUNNER_INTEGRATION") != "1":
        pytest.skip("real Docker tests require RUNNER_INTEGRATION=1 on a dedicated test daemon/VM")
    if not shutil.which("docker"):
        pytest.skip("docker is not available")
    d = Docker()
    if d.run(["version", "--format", "{{.Server.Version}}"], timeout=10).rc != 0:
        pytest.skip("docker daemon is unavailable")
    if d.run(["image", "inspect", IMAGE], timeout=10).rc != 0:
        pytest.skip("the analysis image is unavailable")
    try:
        inventory = d.run(["ps", "-a", "-q", "--filter", "label=logless.job"], timeout=10)
    except Exception:
        pytest.skip("cannot verify the test daemon has no existing logless.job containers")
    if inventory.rc != 0:
        pytest.skip("cannot verify the test daemon has no existing logless.job containers")
    if inventory.out.strip():
        pytest.skip("existing logless.job containers found; use a dedicated idle test daemon/VM")
    return d


@pytest.fixture(scope="module")
def sup(tmp_path_factory):
    docker = integration_docker()  # immediately before startup, not a collection-time probe
    # Docker Desktop shares /private and /var/folders, so pytest's tmp dir can be bind-mounted.
    work = tmp_path_factory.mktemp("runner-jobs")
    s = config.Settings(token="it", bind="127.0.0.1:0", runtime=RUNTIME, image=IMAGE, image_digest="", work_dir=Path(work),
                        concurrency=2, result_ttl_s=900, docker_bin="docker", tmp_tmpfs=config.TMP_TMPFS,
                        out_tmpfs=config.OUT_TMPFS)
    sv = Supervisor(s, docker=docker)
    sv.start()
    yield sv
    sv.stop()


def run(sup: Supervisor, code: str, timeout_s: float = 10.0, files: dict | None = None) -> dict:
    spec = JobSpec(job_id=str(uuid.uuid4()), kind="analysis", code=code, files=files or {"contract.json": "{}"},
                   timeout_s=timeout_s, memory_mb=512)
    rec, _ = sup.submit(spec)
    deadline = time.monotonic() + timeout_s + 60
    while time.monotonic() < deadline:
        v = rec.view()
        if v["state"] in ("succeeded", "failed", "timed_out"):
            return v
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def no_container_left(job_id: str) -> bool:
    out = subprocess.run(["docker", "ps", "-a", "-q", "--filter", f"label=logless.job={job_id}"], capture_output=True, text=True)
    return out.returncode == 0 and not out.stdout.strip()


def test_hello(sup):
    v = run(sup, "import json, pandas\nprint('noise on stdout')\n"
                 "json.dump({'hello': 'world', 'files': sorted(__import__('os').listdir('/in'))}, open('/out/result.json', 'w'))\n")
    assert v["state"] == "succeeded", v
    out = json.loads(v["output"])
    assert out["hello"] == "world" and out["files"] == ["contract.json", "main.py", "program.py"]
    assert v["runtime"] == RUNTIME and v["container_removed"] is True and no_container_left(v["job_id"])
    assert "noise on stdout" in v["stderr_tail"]  # program stdout goes to stderr, never to the result channel


def test_timeout_killed_at_deadline(sup):
    v = run(sup, "while True:\n    pass\n", timeout_s=2.0)
    assert v["state"] == "timed_out" and v["timed_out"] is True and v["output"] is None
    assert 2000 <= v["elapsed_ms"] <= 3500, v["elapsed_ms"]
    assert v["container_removed"] is True and no_container_left(v["job_id"])


def test_no_network(sup):
    code = (
        "import json, socket\n"
        "res = {}\n"
        "for name, fn in [('tcp', lambda: socket.create_connection(('1.1.1.1', 53), timeout=2)),\n"
        "                 ('dns', lambda: socket.getaddrinfo('example.com', 80))]:\n"
        "    try:\n"
        "        fn(); res[name] = 'reachable'\n"
        "    except OSError:\n"
        "        res[name] = 'blocked'\n"
        "json.dump(res, open('/out/result.json', 'w'))\n"
    )
    v = run(sup, code)
    assert v["state"] == "succeeded", v
    out = json.loads(v["output"])
    assert out["tcp"] == "blocked" and out["dns"] == "blocked"


def test_output_too_large(sup):
    v = run(sup, "open('/out/result.json', 'w').write('x' * (1024 * 1024 + 100))\n")
    assert v["state"] == "failed" and v["error"] == "output_too_large" and v["output"] is None
    assert v["container_removed"] is True


def test_out_is_size_capped(sup):
    v = run(sup, "open('/out/result.json', 'w').write('x' * (3 * 1024 * 1024))\n")
    assert v["state"] == "failed" and v["error"] == "nonzero_exit"
    assert "No space left" in v["stderr_tail"]


def test_out_inode_cap(sup):
    # runc enforces nr_inodes=16 (ENOSPC -> nonzero exit); gVisor's tmpfs ignores nr_inodes, so the
    # bootstrap enforces the stricter output contract: only result.json may exist in /out.
    v = run(sup, "for i in range(40):\n    open(f'/out/f{i}', 'w').close()\nopen('/out/result.json', 'w').write('{}')\n")
    assert v["state"] == "failed" and v["output"] is None
    assert v["error"] in ("nonzero_exit", "too_many_output_files")


def test_extra_output_file_rejected(sup):
    v = run(sup, "open('/out/extra.txt', 'w').write('unexpected')\nopen('/out/result.json', 'w').write('{}')\n")
    assert v["state"] == "failed" and v["output"] is None
    assert v["error"] == "too_many_output_files"


def test_symlink_result_rejected(sup):
    v = run(sup, "import os\nos.symlink('/in/contract.json', '/out/result.json')\n")
    assert v["state"] == "failed" and v["error"] == "output_not_regular_file" and v["output"] is None


def test_inputs_read_only_and_root_read_only(sup):
    code = (
        "import json\nres = {}\n"
        "for p in ['/in/x', '/etc/x', '/work/x']:\n"
        "    try:\n        open(p, 'w'); res[p] = 'writable'\n"
        "    except OSError:\n        res[p] = 'denied'\n"
        "import os\nres['uid'] = os.getuid()\nres['env'] = sorted(os.environ)\n"
        "json.dump(res, open('/out/result.json', 'w'))\n"
    )
    v = run(sup, code)
    out = json.loads(v["output"])
    assert out["/in/x"] == out["/etc/x"] == out["/work/x"] == "denied"
    assert out["uid"] == 10001
    # Only the image's own ENV (e.g. python's GPG_KEY release-key id) — nothing from the runner.
    assert not any(k.startswith(("RUNNER_", "VULTR", "TYPESAFE", "FIREWORKS", "DOCKER")) for k in out["env"])


def test_nonzero_exit(sup):
    v = run(sup, "import pandas as pd\npd.read_csv('/in/missing.csv')\n")
    assert v["state"] == "failed" and v["error"] == "nonzero_exit" and v["exit_code"] == 1
    assert "FileNotFoundError" in v["stderr_tail"]
