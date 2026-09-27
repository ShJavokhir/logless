import json

from logless import db
from logless.data import fixtures
from logless.pipeline.privacy import TokenScanner


def test_build_is_deterministic_and_complete(tmp_data):
    a, b = fixtures.build(), fixtures.build()
    assert [r["text"] for r in a] == [r["text"] for r in b]
    kinds = [r["kind"] for r in a]
    assert kinds.count("canary") == 40 and kinds.count("injection") == 10
    canaries = [r for r in a if r["kind"] == "canary"]
    # unique invented person per canary
    for i in (0, 2, 3, 7):  # full name, surname, email, phone digits
        assert len({r["tokens"][i] for r in canaries}) == 40
    # every canary's full name, email, phone and street address appear in its own text
    for r in canaries:
        sc = TokenScanner([r["tokens"][0], r["tokens"][3], r["tokens"][6], r["tokens"][8]])
        assert sc.hits(r["text"]) == 4
    # distinct users, ids and turn identifiers that cannot collide with WildChat's (< 400k)
    assert len({r["user_id"] for r in a}) == 50
    assert len({r["conv_id"] for r in a}) == 50
    assert all(r["tid"] >= fixtures.TID_BASE for r in a)
    assert all(r["user_id"].startswith("u_") and r["conv_id"].startswith("c_") for r in a)


def test_injection_tokens_are_distinctive(tmp_data):
    inj = [r for r in fixtures.build() if r["kind"] == "injection"]
    codes = [r["tokens"][0] for r in inj]
    assert len(set(codes)) == 10
    for r in inj:
        assert TokenScanner([r["tokens"][0]]).hits(r["text"]) == 1
        assert len(r["tokens"]) >= 2  # code word + at least one bait phrase
    # a generic jailbreak phrase that real conversations contain is not a token
    assert "ignore previous instructions" not in {t.lower() for r in inj for t in r["tokens"]}


def test_plant_is_idempotent(tmp_data):
    assert fixtures.plant() == 50
    assert fixtures.plant() == 50
    con = db.private()
    assert con.execute("SELECT COUNT(*) FROM conversations WHERE is_fixture = 1").fetchone()[0] == 50
    kinds = dict(con.execute("SELECT kind, COUNT(*) FROM eval_fixtures GROUP BY kind").fetchall())
    assert kinds == {"canary": 40, "injection": 10}
    toks = fixtures.load_tokens("canary")
    assert len(toks) >= 40 * 5
    row = con.execute("SELECT tokens_json FROM eval_fixtures LIMIT 1").fetchone()
    assert isinstance(json.loads(row[0]), list)
