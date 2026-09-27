"""A failed program branch must not abandon an already-running sibling call."""
import threading

from logless.providers.http import ProviderError
from logless.sandbox import analysis
from logless.sandbox.runs import Run


def test_program_failure_drains_started_sibling_before_releasing_the_run(tmp_data, monkeypatch):
    started, release, sibling_finished, returned = [threading.Event() for _ in range(4)]
    errors = []

    def write(program):
        if program.name == "B":
            started.set()
            release.wait(5)
            sibling_finished.set()
        else:
            assert started.wait(2)
            raise ProviderError("glm", 401, "auth_error")

    monkeypatch.setattr(analysis, "_write_code", write)
    run = Run.create("analysis", "question", "snap_20260927T000000_abcd")
    plan = {"group_by": "category", "scope_category_id": None, "measure": "conversations",
            "signal": None, "rank_by": "count", "limit": 3}

    def drive():
        try:
            analysis._two_programs(run, snapshot_id=run.doc["snapshot_id"], plan=plan,
                                   task="test", files={}, runner=None, check=lambda _: None)
        except ProviderError as error:
            errors.append(error.code)
        finally:
            returned.set()

    worker = threading.Thread(target=drive)
    worker.start()
    try:
        assert started.wait(2)
        returned_before_sibling = returned.wait(0.2)
    finally:
        release.set()
        worker.join(3)
    assert not returned_before_sibling
    assert returned.is_set() and sibling_finished.is_set()
    assert errors == ["auth_error"]
