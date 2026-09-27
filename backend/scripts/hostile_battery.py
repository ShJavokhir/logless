"""Fire hostile programs at the real sandbox runner and report what happened.

Run on the app VM as the logless user (it needs RUNNER_URL/RUNNER_TOKEN from /etc/logless/env):
    .venv/bin/python scripts/hostile_battery.py
Each program tries something dangerous and, if it survives, writes what it observed to /out/result.json.
Nothing here touches private data: the jobs get no input files."""
from __future__ import annotations

import json
import time

from logless.sandbox.client import RunnerClient

REPORT = "import json\ndef report(**k):\n    open('/out/result.json','w').write(json.dumps(k))\n"

PROGRAMS = {
    "rm -rf /": REPORT + """
import subprocess, os
r = subprocess.run(['rm', '-rf', '--no-preserve-root', '/'], capture_output=True, text=True)
report(rm_exit=r.returncode, python_still_there=os.path.exists('/usr/local/bin/python3'),
       stderr_sample=r.stderr.splitlines()[:2], can_write_root=os.access('/', os.W_OK))
""",
    "fork bomb": REPORT + """
import os, time
n = 0; err = None
try:
    while True:
        if os.fork() == 0:
            time.sleep(30); os._exit(0)
        n += 1
except Exception as e:
    err = type(e).__name__
report(forks_before_refused=n, error=err)
""",
    "memory bomb (2 GiB)": REPORT + """
blocks = []
for i in range(2048):
    blocks.append(bytearray(1024 * 1024))
report(allocated_mib=len(blocks))
""",
    "disk fill": REPORT + """
import os
def fill(path):
    n = 0
    try:
        with open(path, 'wb') as f:
            while True:
                f.write(b'x' * (1 << 20)); f.flush(); n += 1
                if n > 4096: break
    except Exception as e:
        return n, type(e).__name__
    return n, None
tmp = fill('/tmp/fill.bin'); os.remove('/tmp/fill.bin')
report(tmp_mib_before_full=tmp[0], tmp_error=tmp[1])
""",
    "network exfiltration": REPORT + """
import socket
def try_conn(host, port):
    try:
        socket.create_connection((host, port), 2); return 'CONNECTED'
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)[:60]
def try_dns(name):
    try:
        return socket.gethostbyname(name)
    except Exception as e:
        return type(e).__name__
report(internet=try_conn('1.1.1.1', 443), cloud_metadata=try_conn('169.254.169.254', 80),
       app_vm_private=try_conn('10.20.0.3', 8000), dns=try_dns('example.com'))
""",
    "secret hunting": REPORT + """
import os, glob
hits = []
for pat in ['/run/secrets/*', '/etc/logless*', '/etc/logless-runner/*', '/root/*', '/home/*/.ssh/*', '/var/run/docker.sock']:
    hits += glob.glob(pat)
try:
    pid1 = open('/proc/1/environ', 'rb').read().split(b'\\0')
    pid1_keys = sorted({x.split(b'=')[0].decode() for x in pid1 if b'=' in x})
except Exception as e:
    pid1_keys = type(e).__name__
report(env_keys=sorted(os.environ.keys()), secret_like_env=[k for k in os.environ if any(s in k for s in ('KEY', 'TOKEN', 'SECRET', 'PASS'))],
       files_found=hits, pid1_env_keys=pid1_keys)
""",
    "host escape probes": REPORT + """
import os, subprocess, platform
def attempt(f):
    try:
        f(); return 'ALLOWED'
    except Exception as e:
        return type(e).__name__
cap = [l for l in open('/proc/self/status') if l.startswith('CapEff')][0].split()[1]
report(kernel=platform.release(), uid=os.getuid(), cap_eff=cap,
       setuid_root=attempt(lambda: os.setuid(0)),
       mount=subprocess.run(['mount', '-t', 'tmpfs', 'x', '/mnt'], capture_output=True).returncode,
       sysrq=attempt(lambda: open('/proc/sysrq-trigger', 'w').write('b')),
       write_in=attempt(lambda: open('/in/evil', 'w').write('x')))
""",
}


def main() -> None:
    rc = RunnerClient()
    rows = []
    for name, code in PROGRAMS.items():
        t0 = time.monotonic()
        res = rc.run(kind="containment", code=code, files={}, timeout_s=5, memory_mb=512)
        out = None
        if res.output:
            try:
                out = json.loads(res.output)
            except ValueError:
                out = res.output[:200]
        rows.append({"attack": name, "state": res.state, "exit_code": res.get("exit_code"), "timed_out": res.get("timed_out"),
                     "container_removed": res.get("container_removed"), "runtime": res.get("runtime"),
                     "wall_s": round(time.monotonic() - t0, 2), "observed_inside": out})
    health = rc.health()
    print(json.dumps({"results": rows, "runner_health_after": health}, indent=1))


if __name__ == "__main__":
    main()
