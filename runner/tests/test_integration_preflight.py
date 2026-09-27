"""Safety checks for the integration harness, using only fake Docker adapters."""
from __future__ import annotations

import runpy
from pathlib import Path

import pytest

from logless_runner import docker as docker_module
from logless_runner.docker import Result

from . import test_integration as integration


class Probe:
    def __init__(self, inventory=None):
        self.inventory = inventory if inventory is not None else Result(0, "", "")
        self.calls = []

    def run(self, args, timeout):
        self.calls.append(args)
        if args[0] == "ps":
            if isinstance(self.inventory, Exception):
                raise self.inventory
            return self.inventory
        assert args[0] in ("version", "image")  # preflight must be read-only
        return Result(0, "available", "")


def test_default_collection_does_not_probe_docker(monkeypatch):
    monkeypatch.delenv("RUNNER_INTEGRATION", raising=False)

    def forbidden(*args, **kwargs):
        pytest.fail("default integration collection must not probe Docker")

    monkeypatch.setattr(integration.shutil, "which", forbidden)
    monkeypatch.setattr(docker_module, "Docker", forbidden)
    monkeypatch.setattr(integration.subprocess, "run", forbidden)
    runpy.run_path(str(Path(integration.__file__)))


@pytest.mark.parametrize("setting", [None, "0", "true", "yes"])
def test_explicit_opt_in_is_required_before_even_readiness_probes(monkeypatch, setting):
    if setting is None:
        monkeypatch.delenv("RUNNER_INTEGRATION", raising=False)
    else:
        monkeypatch.setenv("RUNNER_INTEGRATION", setting)

    def forbidden(*args, **kwargs):
        pytest.fail("no readiness probe or supervisor construction is allowed without opt-in")

    monkeypatch.setattr(integration.shutil, "which", forbidden)
    monkeypatch.setattr(integration, "Docker", forbidden)
    monkeypatch.setattr(integration, "Supervisor", forbidden)
    with pytest.raises(pytest.skip.Exception, match="RUNNER_INTEGRATION=1"):
        next(integration.sup.__wrapped__(object()))


@pytest.mark.parametrize("inventory", [
    Result(0, "existing-job\n", ""),  # running OR stopped labelled containers block startup
    Result(1, "", "inventory failed"),
    Result(124, "", "timeout"),
    Result(125, "", "output_too_large"),
    RuntimeError("unknown inventory"),
])
def test_busy_or_uncertain_daemon_never_constructs_supervisor(monkeypatch, inventory):
    monkeypatch.setenv("RUNNER_INTEGRATION", "1")
    monkeypatch.setattr(integration.shutil, "which", lambda name: "/fake/docker")
    probe = Probe(inventory)
    monkeypatch.setattr(integration, "Docker", lambda: probe)
    monkeypatch.setattr(integration, "Supervisor", lambda *a, **k: pytest.fail("must not construct a supervisor"))
    with pytest.raises(pytest.skip.Exception, match="logless.job"):
        next(integration.sup.__wrapped__(object()))
    assert probe.calls[-1] == ["ps", "-a", "-q", "--filter", "label=logless.job"]
    assert all(call[0] in ("version", "image", "ps") for call in probe.calls)


def test_empty_dedicated_daemon_reuses_the_probed_adapter(monkeypatch, tmp_path):
    monkeypatch.setenv("RUNNER_INTEGRATION", "1")
    monkeypatch.setattr(integration.shutil, "which", lambda name: "/fake/docker")
    probe, events = Probe(), []
    monkeypatch.setattr(integration, "Docker", lambda: probe)

    class SupervisorSpy:
        def __init__(self, settings, docker):
            assert docker is probe  # no environment/context switch between probe and supervisor

        def start(self):
            events.append("start")

        def stop(self):
            events.append("stop")

    class TempFactory:
        def mktemp(self, name):
            return tmp_path

    monkeypatch.setattr(integration, "Supervisor", SupervisorSpy)
    fixture = integration.sup.__wrapped__(TempFactory())
    assert isinstance(next(fixture), SupervisorSpy)
    assert events == ["start"]
    with pytest.raises(StopIteration):
        next(fixture)
    assert events == ["start", "stop"]
    assert [call[0] for call in probe.calls] == ["version", "image", "ps"]
