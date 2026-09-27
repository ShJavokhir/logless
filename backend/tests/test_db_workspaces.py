"""Changing an operator workspace must not reuse the previous SQLite connection."""
import pytest

from logless import config, db


def test_new_workspace_does_not_reuse_previous_private_database(tmp_data, tmp_path, monkeypatch):
    first = db.private()
    first.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, text) VALUES (?,?,?,?)",
                  ("c_000000000001", 1, "u_0000000001", "private workspace one"))
    first.commit()
    second_dir = tmp_path / "another-workspace"
    monkeypatch.setenv("LOGLESS_DATA_DIR", str(second_dir))
    config.settings.cache_clear()
    second = db.private()
    assert second.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0
    assert second_dir.joinpath("private.db").is_file()


def test_switch_cannot_silently_discard_an_uncommitted_write(tmp_data, tmp_path, monkeypatch):
    first = db.private()
    first.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, text) VALUES (?,?,?,?)",
                  ("c_000000000001", 1, "u_0000000001", "pending private input"))
    monkeypatch.setenv("LOGLESS_DATA_DIR", str(tmp_path / "another-workspace"))
    config.settings.cache_clear()
    with pytest.raises(RuntimeError, match="open database transaction"):
        db.private()
    assert first.in_transaction
    assert first.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 1
    first.rollback()


def test_workspace_connection_failure_can_be_retried(tmp_data, tmp_path, monkeypatch):
    import sqlite3
    db.private()
    monkeypatch.setenv("LOGLESS_DATA_DIR", str(tmp_path / "another-workspace"))
    config.settings.cache_clear()
    connect = db._connect
    calls = 0

    def fail_once(path):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise sqlite3.OperationalError("temporary open failure")
        return connect(path)

    monkeypatch.setattr(db, "_connect", fail_once)
    with pytest.raises(sqlite3.OperationalError):
        db.private()
    # The closed connection from the previous workspace must not poison this thread.
    assert db.private().execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0
