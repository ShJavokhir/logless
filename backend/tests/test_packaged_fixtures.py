"""Run against both editable installs and a built wheel; never execute hostile fixtures."""
from pathlib import Path

from logless.sandbox.containment import TASKS_DIR, task_source


def test_containment_fixtures_match_reviewed_source_bytes():
    source = Path(__file__).resolve().parents[1] / "sandbox_tasks"
    for name in ("destructive.py", "followup.py", "leak_attempt.py", "runaway.py"):
        expected = (source / name).read_bytes()
        assert (TASKS_DIR / name).is_file()
        assert (TASKS_DIR / name).read_bytes() == expected
        assert task_source(name) == expected.decode("utf-8")
