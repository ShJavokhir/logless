import asyncio
import json

import httpx
import pytest

from logless import db
from logless.pipeline.fast_classify import (
    MODEL, OTHER_LABEL, Options, RateGate, Summary, classify_prepared, prepare, retry_after,
)


THEMES = [{"theme_id": "code", "name": "Programming", "description": "Write or debug software"},
          {"theme_id": "write", "name": "Writing", "description": "Draft or edit prose"}]


def response(request, *, p=1.0, choice="t0"):
    body = json.loads(request.content)
    answers = {}
    for key, q in body["questions"].items():
        probs = dict.fromkeys(q["criteria"], 0.0)
        probs[choice] = p
        probs["t1" if choice != "t1" else "t0"] += 1 - p
        answers[key] = {"type": "choice", "choice": choice, "confidence": 0.4, "probabilities": probs}
    return {"model": MODEL, "answers": answers, "usage": {"input_tokens": 450, "output_tokens": 40}}


def test_complete_private_storage_and_probability_cutoff(tmp_data):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=response(request, p=0.64 if len(calls) == 1 else 0.8))

    summaries = [Summary("s1", "Fix a bug"), Summary("s2", "Write Python")]
    result = classify_prepared(summaries, THEMES, key="test", options=Options(batch_size=1),
                               transport=httpx.MockTransport(handler), labels={"s1": "other", "s2": "code"})
    assert result["errors"] == 0 and result["assignments"] == 2
    assert result["accuracy"]["value"] == 1
    assert not result["target_met"] and not result["live"]
    rows = list(db.private().execute("SELECT theme_id,p FROM assignments ORDER BY conv_id"))
    assert [tuple(r) for r in rows] == [("other", 0.64), ("code", 0.8)]
    evidence = db.private().execute("SELECT confidence,model FROM prepared_assignment_evidence").fetchone()
    assert tuple(evidence) == (0.4, MODEL)  # provider confidence is not the legacy top-p threshold
    assert not (tmp_data / "public.db").exists()
    assert db.private().execute("SELECT count(*) FROM llm_cache").fetchone()[0] == 0
    assert "Fix a bug" not in json.dumps(result)


def test_both_layouts_same_decision_without_other_summaries():
    summaries = [Summary("s1", "alpha"), Summary("s2", "beta")]
    single = prepare(summaries, THEMES, Options(layout="single"), "nonce")
    shared = prepare(summaries, THEMES, Options(), "nonce")
    assert len(single) == 2 and len(shared) == 1
    assert single[0].questions["s1"] == shared[0].questions["s1"]
    assert json.loads(single[0].body)["state"] == json.loads(shared[0].body)["state"]
    assert "beta" not in json.dumps(shared[0].questions["s1"])
    assert OTHER_LABEL in shared[0].questions["s1"]["criteria"]


def test_packing_both_limits_and_no_truncation():
    summaries = [Summary(f"s{i}", "漢字🙂" * 180) for i in range(30)]
    batches = prepare(summaries, THEMES, Options(batch_size=10000), "n")
    assert len(batches) > 1
    assert [sid for b in batches for sid in b.ids] == [s.summary_id for s in summaries]
    for b in batches:
        assert b.token_bound <= 60_000 and b.context_bound <= 30_000
        assert len(b.body) < b.token_bound
        assert all(q["instructions"]["summary"] == summaries[0].summary for q in b.questions.values())
    with pytest.raises(ValueError, match="shorter summary"):
        prepare([Summary("s", "a" * 40_000)], THEMES, Options(), "n")


@pytest.mark.parametrize("summaries,themes", [
    ([Summary("s", "a"), Summary("s", "b")], THEMES),
    ([Summary("bad.dot", "a")], THEMES),
    ([Summary("s", "a")], THEMES + [THEMES[0]]),
    ([Summary("s", "a")], [{"theme_id": "other", "name": "Reserved"}]),
    ([Summary("s", "a")], [{"theme_id": str(i), "name": str(i)} for i in range(255)]),
])
def test_reject_invalid_inputs(summaries, themes):
    with pytest.raises(ValueError):
        prepare(summaries, themes, Options(), "n")


@pytest.mark.parametrize("mutation", [
    lambda out: out["answers"].clear(),
    lambda out: out["answers"].update(extra=out["answers"]["s"]),
    lambda out: out["answers"]["s"].update(confidence=float("nan")),
    lambda out: out["answers"]["s"]["probabilities"].update(t1=0.5),
    lambda out: out.update(model="unexpected-model"),
    lambda out: out.update(usage={"input_tokens": True, "output_tokens": 10}),
])
def test_malformed_answer_becomes_explicit_error_other(tmp_data, mutation):
    def handler(request):
        out = response(request)
        mutation(out)
        return httpx.Response(200, content=json.dumps(out).encode())
    result = classify_prepared([Summary("s", "task")], THEMES, key="test", options=Options(attempts=1),
                               transport=httpx.MockTransport(handler))
    assert result["status"] == "degraded" and result["errors"] == 1
    assert result["other"] == 1 and not result["target_met"]
    assert db.private().execute("SELECT error FROM prepared_assignment_evidence").fetchone()[0]


def test_retry_headers():
    assert retry_after(httpx.Headers({"retry-after": "120", "retry-after-ms": "2500"})) == 120
    assert retry_after(httpx.Headers({"retry-after": "Thu, 01 Jan 1970 00:02:00 GMT"}), now=60) == 60
    assert retry_after(httpx.Headers({"retry-after": "nonsense"})) == 0
    assert retry_after(httpx.Headers({"retry-after": "nan"})) == 0


def test_retry_after_honored_and_metered(tmp_data):
    import time
    starts = []

    def handler(request):
        starts.append(time.perf_counter())
        if len(starts) == 1:
            return httpx.Response(429, headers={"retry-after": "0.65"})
        return httpx.Response(200, json=response(request))

    result = classify_prepared([Summary("s", "task")], THEMES, key="test",
                               transport=httpx.MockTransport(handler))
    assert starts[1] - starts[0] >= 0.65
    assert result["rate_limit_responses"] == 1
    assert len(result["attempts"]) == 2 and result["errors"] == 0
    assert result["attempts"][0]["retry_after_s"] == 0.65
    assert result["end_to_end_s"] >= 0.65


def test_fatal_stops_and_records_no_fake_assignments(tmp_data):
    result = classify_prepared([Summary(f"s{i}", "task") for i in range(100)], THEMES, key="test",
                               options=Options(batch_size=1, concurrency=2),
                               transport=httpx.MockTransport(lambda r: httpx.Response(401)))
    assert result["status"] == "failed" and result["error"] == "auth_error"
    assert len(result["attempts"]) <= 2
    assert db.private().execute("SELECT count(*) FROM assignments").fetchone()[0] == 0
    assert db.private().execute("SELECT count(*) FROM prepared_classification_runs").fetchone()[0] == 1


def test_rate_gate_paces_requests_and_token_window(monkeypatch):
    import logless.pipeline.fast_classify as fc
    clock = [100.0]
    sleeps = []

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    monkeypatch.setattr(fc.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(fc.asyncio, "sleep", sleep)

    async def run():
        gate = RateGate(Options(tokens_per_second=1000))
        await gate.acquire(600)
        await gate.acquire(400)
        assert clock[0] == pytest.approx(100.05)
        await gate.acquire(1)
        assert clock[0] >= 101
        gate.pause(5)
        await gate.acquire(1)
        assert clock[0] >= 106
    asyncio.run(run())
    assert sleeps


def test_10000_coverage_is_not_a_live_benchmark(tmp_data):
    summaries = [Summary(f"s{i}", f"task {i}") for i in range(10_000)]
    result = classify_prepared(summaries, THEMES, key="test",
                               options=Options(batch_size=128, requests_per_minute=10**9, tokens_per_second=10**9),
                               transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response(r))))
    assert result["assignments"] == 10_000 and result["errors"] == 0
    assert db.private().execute("SELECT count(DISTINCT conv_id) FROM assignments").fetchone()[0] == 10_000
    assert not result["target_met"] and not result["latency_target_met"]


def test_benchmark_rejects_duplicate_keys():
    from logless.pipeline.fast_classify import strict_json
    with pytest.raises(ValueError, match="duplicate"):
        strict_json('{"s":"code","s":"write"}')


def test_calibrated_gate_corrects_underestimated_tokens():
    async def run():
        gate = RateGate(Options(token_rate_ratio=0.2))
        ticket, reserved = await gate.acquire(1000)
        assert reserved == 200
        gate.observe(ticket, 1000, 400)
        assert gate.tokens == [(ticket, 400)]
        assert gate.ratio == pytest.approx(0.44)
        _, next_reserved = await gate.acquire(1000)
        assert next_reserved >= 440
    asyncio.run(run())


def test_repeated_runs_do_not_reuse_cache(tmp_data):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=response(request))

    for _ in range(2):
        result = classify_prepared([Summary("s", "task")], THEMES, key="test",
                                   transport=httpx.MockTransport(handler))
        assert result["errors"] == 0
    assert len(requests) == 2
    assert requests[0]["state"]["run_nonce"] != requests[1]["state"]["run_nonce"]
    assert db.private().execute("SELECT count(*) FROM llm_cache").fetchone()[0] == 0


def test_storage_failure_rolls_back_all_assignments(tmp_data):
    import sqlite3
    # Reject the second assignment to simulate a disk/constraint failure mid-commit.
    db.private().executescript("""
      CREATE TRIGGER reject_assignment BEFORE INSERT ON assignments
      WHEN NEW.conv_id='s2' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;
    """)
    with pytest.raises(sqlite3.IntegrityError):
        classify_prepared([Summary("s1", "a"), Summary("s2", "b")], THEMES, key="test",
                          transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response(r))))
    assert db.private().execute("SELECT count(*) FROM assignments").fetchone()[0] == 0
    assert db.private().execute("SELECT count(*) FROM prepared_assignment_evidence").fetchone()[0] == 0
