import pytest


@pytest.fixture()
def tmp_data(tmp_path, monkeypatch):
    """Isolated data dir: fresh private.db / public.db, no network."""
    from logless import config, db
    monkeypatch.setenv("LOGLESS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PSEUDONYM_SALT", "test-salt")
    monkeypatch.setenv("N_CANARY", "40")
    monkeypatch.setenv("MIN_LEAF_PEOPLE", "1")         # fixture corpora are tiny; test_gate_floor covers the real floor
    monkeypatch.setenv("MIN_LEAF_CONVERSATIONS", "1")
    config.settings.cache_clear()
    if hasattr(db._local, "cons"):
        for con in db._local.cons.values():
            con.close()
        db._local.cons = {}
    yield tmp_path
    if hasattr(db._local, "cons"):
        for con in db._local.cons.values():
            con.close()
        db._local.cons = {}
    config.settings.cache_clear()
