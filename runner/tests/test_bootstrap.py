"""Exercise result collection in a temporary directory, without launching any program."""
import os
from types import SimpleNamespace

from logless_runner import bootstrap


def test_only_one_output_file_is_accepted(tmp_path, monkeypatch):
    result = tmp_path / "result.json"
    result.write_text("{}")
    real_scandir = os.scandir
    monkeypatch.setattr(bootstrap, "OUT", str(result))
    monkeypatch.setattr(bootstrap, "os", SimpleNamespace(
        scandir=lambda path: real_scandir(tmp_path), open=os.open, fstat=os.fstat, read=os.read, close=os.close,
        O_RDONLY=os.O_RDONLY, O_NOFOLLOW=os.O_NOFOLLOW, O_NONBLOCK=os.O_NONBLOCK))
    assert bootstrap._read_result() == ("ok", b"{}")
    (tmp_path / "unexpected.txt").write_text("unexpected")
    assert bootstrap._read_result() == ("too_many_files", b"")
