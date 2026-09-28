import math

import httpx
import numpy as np
import pytest

from logless.pipeline import facets, prompts, util
from logless.providers import fireworks, glm, http, jev
from logless.providers.http import ProviderError


@pytest.mark.parametrize("answer", [
    {"choice": "a", "probabilities": {"b": 1.0}},
    {"choice": "a", "probabilities": {"a": float("nan")}},
    {"choice": "a", "probabilities": {"a": float("inf")}},
    {"choice": "a", "probabilities": {"a": -0.1}},
    {"choice": "a", "probabilities": {"a": "0.9"}},
    {"choice": "a", "probabilities": {"a": True}},
])
def test_choice_rejects_missing_or_invalid_selected_probability(answer):
    with pytest.raises(ProviderError, match="malformed_choice"):
        jev.top(answer)


def test_choice_cutoff_uses_selected_probability_not_provider_confidence():
    answer = {"choice": "observed", "probabilities": {"observed": 0.7, "not_observed": 0.3}, "confidence": 0.2}
    assert jev.tri_state(answer) == ("observed", "observed", 0.7)
    # Observed provider responses occasionally choose below the distribution's max.
    # Use the selected option's own probability, never borrow the other option's certainty.
    assert jev.top({"choice": "a", "probabilities": {"a": 0.1, "b": 0.9}}) == ("a", 0.1)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -0.1, 1.1, True, "0.1"])
def test_noul_validation_is_fail_closed(value):
    with pytest.raises(ProviderError, match="malformed_noul"):
        jev.validate_answers({"pii": {"type": "noul", "noul": value}}, {"pii": {"type": "noul"}})


def test_malformed_cached_jev_answer_is_not_trusted(tmp_data, monkeypatch):
    bad = {"pii": {"type": "noul", "noul": float("nan")}}
    monkeypatch.setattr(util, "cache_get", lambda _: bad)
    with pytest.raises(ProviderError, match="malformed_noul"):
        util.jev_ask({}, {"pii": {"type": "noul"}})


@pytest.mark.parametrize("data", [
    [{"index": 0, "embedding": [1, 0]}, {"index": 0, "embedding": [0, 1]}],
    [{"index": 0, "embedding": [1, 0]}, {"index": 2, "embedding": [0, 1]}],
    [{"index": 0, "embedding": [1, math.nan]}, {"index": 1, "embedding": [0, 1]}],
    [{"index": 0, "embedding": [1]}, {"index": 1, "embedding": [0, 1]}],
    [{"index": 0, "embedding": [0, 0]}, {"index": 1, "embedding": [0, 1]}],
])
def test_embeddings_reject_wrong_identity_shape_and_values(data, monkeypatch):
    monkeypatch.setattr(fireworks, "post_json", lambda *a, **kw: {"data": data})
    with pytest.raises(ProviderError):
        fireworks.embed(["task one", "task two"], dims=2)


def test_embeddings_restore_provider_order(monkeypatch):
    monkeypatch.setattr(fireworks, "post_json", lambda *a, **kw: {"data": [
        {"index": 1, "embedding": [0, 2]}, {"index": 0, "embedding": [3, 0]}]})
    assert np.array_equal(fireworks.embed(["one", "two"], dims=2), np.eye(2))


def test_large_finite_embedding_does_not_overflow_to_zero(monkeypatch):
    monkeypatch.setattr(fireworks, "post_json", lambda *a, **kw: {"data": [
        {"index": 0, "embedding": [3e38, 3e38]}]})
    vector = fireworks.embed(["one"], dims=2)
    assert np.isfinite(vector).all()
    assert np.linalg.norm(vector) == pytest.approx(1.0)


def test_http_retries_malformed_success_without_exposing_response(monkeypatch):
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(200, text="private upstream text") if len(calls) == 1 else httpx.Response(200, json={"ok": True})
    monkeypatch.setattr(http, "_client", httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(http.time, "sleep", lambda _: None)
    assert http.post_json("test", "https://example.invalid", "key", {}, attempts=2) == {"ok": True}
    assert len(calls) == 2


def test_http_never_logs_free_form_provider_error(monkeypatch, caplog):
    private = "customer@example.invalid asked about a password"
    monkeypatch.setattr(http, "_client", httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(400, json={"error": private}))))
    with pytest.raises(ProviderError) as error:
        http.post_json("test", "https://example.invalid", "key", {})
    assert private not in str(error.value) + caplog.text


def test_pii_fallback_never_embeds_an_unchecked_domain(tmp_data, monkeypatch):
    from logless import db
    facets.ensure_schema()
    private = "private.person@example.invalid"
    monkeypatch.setattr(facets.util, "glm_json", lambda *args, **kwargs: prompts.Facets(
        user_goal="Help with a request", task="Help with a request", domain=private, language="English"))
    monkeypatch.setattr(facets, "_pii", lambda _: 0.99)
    status, _ = facets.extract_one("c_000000000001", "private source")
    row = db.private().execute("SELECT facet_text FROM facets").fetchone()
    assert status == "fallback" and row["facet_text"] == facets.PRIVATE_FACET
    assert private not in row["facet_text"]


def test_live_glm_timeout_and_attempts_reach_transport(tmp_data, monkeypatch):
    calls = []
    def post(*args, **kwargs):
        calls.append(kwargs)
        content = json.dumps({"user_goal": "Help", "task": "Help", "domain": "Support", "language": "English"})
        return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    import json
    monkeypatch.setattr(glm, "post_json", post)
    glm.chat_json("sys", "user", prompts.Facets, timeout=30.0, attempts=1, retries=0, use_cache=False)
    assert calls == [{"timeout": 30.0, "attempts": 1}]


def test_failed_facets_are_retried_on_resume(tmp_data, monkeypatch):
    from logless import db
    from logless.pipeline.questions import CARE, CARE_QV, SIGNALS, FRICTION_QV
    facets.ensure_schema()
    cid = "c_000000000001"
    con = db.private()
    con.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, text) VALUES (?,?,?,?)", (cid, 1, "person", "source"))
    con.executemany("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, question_version) VALUES (?,?,?,?,?,?)",
                    [(cid, s, "not_observed", "not_observed", 1.0, FRICTION_QV) for s in SIGNALS]
                    + [(cid, s, "not_observed", "not_observed", 1.0, CARE_QV) for s in CARE])
    con.commit()
    facets._mark_failed(cid)
    attempts = []
    monkeypatch.setattr(facets, "extract_one", lambda conv_id, text: attempts.append(conv_id) or ("ok", "fake"))
    facets.run(util.Build("b_test", None, [cid], "now"))
    assert attempts == [cid]


@pytest.mark.parametrize("status", ["fallback", "ok", "rewritten"])
def test_resume_discovery_sanitizes_legacy_fallback_before_embedding(tmp_data, monkeypatch, status):
    from logless import db
    from logless.pipeline import discover
    facets.ensure_schema()
    cid = "c_000000000001"
    con = db.private()
    con.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, text) VALUES (?,?,?,?)", (cid, 1, "person", "source"))
    con.execute("INSERT INTO facets(conv_id, facet_text) VALUES (?,?)", (cid, "Help with private.person@example.invalid"))
    con.execute("INSERT INTO facet_checks(conv_id, status, pii_p) VALUES (?, ?, 0.1)", (cid, status))
    con.commit()
    seen = []
    def embed(texts):
        seen.extend(texts)
        return np.array([[1.0, 0.0]], dtype=np.float32)
    monkeypatch.setattr(discover.fireworks, "embed", embed)
    discover.build_embeddings(util.Build("b_test", None, [cid], "now"))
    assert seen == [facets.PRIVATE_FACET]
    saved = con.execute("SELECT status,pii_p FROM facet_checks WHERE conv_id=?", (cid,)).fetchone()
    assert saved["status"] == "fallback" and saved["pii_p"] == 0.1  # no fabricated fresh model score
    assert con.execute("SELECT text FROM conversations WHERE conv_id=?", (cid,)).fetchone()["text"] == "source"
    assert facets._counts([cid])["pii_fallback"] == 1


def test_outbound_embedding_guard_does_not_reuse_unsafe_text_cache_key(tmp_data, monkeypatch):
    from logless import db
    from logless.config import EMBEDDING_MODEL
    from logless.pipeline import discover
    private = "Email private.person@example.invalid. Goal: receive help."
    con = db.private()
    con.execute(discover.EMB_SCHEMA)
    con.execute("INSERT INTO embedding_cache(key,model,vec) VALUES (?,?,?)",
                (discover._key(private), EMBEDDING_MODEL, np.array([0.0, 1.0], dtype=np.float32).tobytes()))
    con.commit()
    seen = []
    def embed(texts):
        seen.extend(texts)
        return np.array([[1.0, 0.0]], dtype=np.float32)
    monkeypatch.setattr(discover.fireworks, "embed", embed)
    result = discover.embed_texts([private, private])
    assert seen == [facets.PRIVATE_FACET]
    assert np.array_equal(result, np.array([[1.0, 0.0], [1.0, 0.0]], dtype=np.float32))


def test_resume_asks_jev_only_for_missing_decision_sets(tmp_data, monkeypatch):
    """A conversation decided before care signals existed gets one Jev call with only the care questions."""
    from logless import db
    from logless.pipeline.questions import CARE, CARE_QV, SIGNALS, FRICTION_QV
    facets.ensure_schema()
    cid = "c_000000000001"
    con = db.private()
    con.execute("INSERT INTO conversations(conv_id, turn_identifier, user_id, text) VALUES (?,?,?,?)", (cid, 1, "person", "source"))
    con.executemany("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, question_version) VALUES (?,?,?,?,?,?)",
                    [(cid, s, "observed", "observed", 1.0, FRICTION_QV) for s in SIGNALS])
    con.commit()
    asked = []
    tri = lambda c: {"type": "choice", "choice": c, "probabilities": {"observed": 0.9 if c == "observed" else 0.05,
                     "not_observed": 0.9 if c == "not_observed" else 0.05, "unclear": 0.05}}
    def ask(state, questions):
        asked.append(sorted(questions))
        return {q: tri("observed" if q == "refusal" else "not_observed") for q in questions}
    monkeypatch.setattr(util, "jev_ask", ask)
    monkeypatch.setattr(facets, "extract_one", lambda conv_id, text: ("ok", "fake"))
    counts = facets.run(util.Build("b_test", None, [cid], "now"))
    assert asked == [sorted(CARE)]
    got = dict(con.execute("SELECT signal, choice FROM friction WHERE conv_id = ? AND question_version = ?", (cid, CARE_QV)).fetchall())
    assert got == {"refusal": "observed", "sensitive": "not_observed"}
    assert counts["refusal_observed"] == 1 and counts["friction_observed"] == 1
