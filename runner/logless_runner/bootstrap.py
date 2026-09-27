# logless runner bootstrap — copied into every job as /in/main.py (the container command is
# `python /in/main.py`). It is standalone: it imports nothing from the runner package.
#
# Why it exists: /out is a size-capped tmpfs inside the container (≤ 2 MiB, ≤ 16 inodes), and a
# tmpfs disappears when the container stops, so the result has to leave the container while it is
# still running. The bootstrap runs the job's program (/in/program.py) as a separate process whose
# stdout is redirected to stderr, then reads /out/result.json (regular file only — no symlinks,
# FIFOs or devices — at most 1 MiB) and writes it to the real stdout behind a one-line frame
# header. The runner reads that stream through a bounded pipe.
#
# This file is a transport, not a security boundary: a program could forge the frame just as it
# could write any result.json. The egress gate on the app VM validates whatever comes out.
import os
import stat
import subprocess
import sys

OUT = "/out/result.json"
CAP = 1024 * 1024
MAX_ENTRIES = 16  # /out is also mounted with nr_inodes=16, but gVisor's tmpfs ignores that option


def _read_result():
    try:
        with os.scandir("/out") as it:
            for n, _ in enumerate(it, 1):
                if n > MAX_ENTRIES:
                    return "too_many_files", b""
    except OSError:
        return "unreadable", b""
    try:
        fd = os.open(OUT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return "missing", b""
    except OSError:
        return "not_regular", b""  # ELOOP (symlink) and friends
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return "not_regular", b""
        if st.st_size > CAP:
            return "too_large", b""
        chunks, total = [], 0
        while True:
            b = os.read(fd, 65536)
            if not b:
                break
            total += len(b)
            if total > CAP:
                return "too_large", b""
            chunks.append(b)
        return "ok", b"".join(chunks)
    except OSError:
        return "unreadable", b""
    finally:
        os.close(fd)


def main():
    out = os.dup(1)  # private channel back to the runner (not inherited by the child)
    try:
        proc = subprocess.run([sys.executable, "/in/program.py"], stdin=subprocess.DEVNULL, stdout=2, stderr=2,
                              cwd="/tmp", close_fds=True)
        code = proc.returncode
    except OSError:
        code = 127
    if code < 0:  # killed by a signal
        code = 128 - code
    status, data = _read_result() if code == 0 else ("skipped", b"")
    frame = ("LOGLESS/1 %s %d %d\n" % (status, code, len(data))).encode("ascii") + data
    view = memoryview(frame)
    while view:
        n = os.write(out, view)
        view = view[n:]
    os._exit(code)


if __name__ == "__main__":
    main()
