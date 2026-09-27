"""Benign local subprocess probes for the Docker CLI adapter; no Docker daemon is used."""
import os
import sys

import pytest

from logless_runner.docker import Docker


def test_short_command_timeout_reaps_the_cli_process(tmp_path):
    pid_file = tmp_path / "pid"
    # A tiny controlled Python process stands in for a stalled CLI. No child programs or network.
    result = Docker(sys.executable).run([
        "-c", "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(2)",
        str(pid_file),
    ], timeout=0.2)
    assert result.rc == 124 and result.err == "timeout"
    assert pid_file.exists()
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_inventory_output_truncation_cannot_be_mistaken_for_complete_success():
    result = Docker(sys.executable).run(["-c", "import sys; sys.stdout.write('x' * 65537)"])
    assert result.rc != 0 and result.out == "" and result.err == "output_too_large"
