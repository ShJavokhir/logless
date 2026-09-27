"""Containment fixture: a destructive command, absorbed by the sandbox.

Track 1's containment moment is "the sandbox absorbing something unsafe, such as an rm -rf". This
fixed fixture runs that command as the sandbox user inside one disposable gVisor container. The
container's root filesystem is mounted read-only and every capability is dropped, so the command
cannot actually delete the image or reach the host; the container is destroyed afterward either
way. Nothing here is user-supplied — it is a version-controlled demonstration.

The command only runs when every sandbox condition holds (Linux, the sandbox uid, a read-only root,
the gVisor kernel, the /out mount). Anywhere else — a developer laptop, a CI box — it refuses and
reports `ran: false`, and the backend marks the check failed rather than "absorbed".

The program records only what it can observe from *inside* the container and writes that to
/out/result.json: rm's own exit code and how many removals were refused (a count; the error text
is discarded). The backend treats that report as untrusted and informative only: the real verdict
is judged from outside (the container exited and was removed, the runner is still healthy, and the
next program runs cleanly from the same pinned image).
"""
import json
import os
import subprocess
import sys

# A list of arguments, run without a shell. This is the command the sandbox is meant to absorb.
COMMAND = ["rm", "-rf", "--no-preserve-root", "/"]
SANDBOX_UID = 10001


def inside_sandbox() -> bool:
    return (sys.platform == "linux"
            and os.getuid() == SANDBOX_UID
            and not os.access("/", os.W_OK)
            and "gvisor" in os.uname().release
            and os.path.ismount("/out"))


report = {"command": " ".join(COMMAND), "ran": False}
if inside_sandbox():
    report["ran"] = True
    try:
        proc = subprocess.run(COMMAND, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, timeout=6)
        report["rm_exit_code"] = proc.returncode
        report["refused"] = proc.stderr.count(b"\n")   # one "cannot remove" line per refused removal
    except FileNotFoundError:
        report["rm_exit_code"] = 127
    except subprocess.TimeoutExpired:
        report["rm_exit_code"] = None

    # Observations after the command: the root filesystem should be read-only, and the interpreter
    # that will run the next program should still be present (the read-only mount protected it).
    report["root_writable"] = os.access("/", os.W_OK)
    report["python_present"] = os.path.exists("/usr/local/bin/python3")

with open("/out/result.json", "w") as f:
    json.dump(report, f)
