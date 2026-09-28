"""Synthetic reconstruction eval: the generator's output imports as-is, and the scorer reads a real build."""
import json

from logless import db
from logless.data import importer
from logless.eval import reconstruct
from logless.ids import conversation_id
from logless.pipeline import util
from logless.pipeline.questions import FRICTION_QV

MIX = {"topics": [{"id": "math", "weight": 0.5, "description": "math homework"},
                  {"id": "python", "weight": 0.5, "description": "python debugging"}],
       "languages": {"English": 0.5, "Spanish": 0.5}, "correction_rate": 0.3, "conversations_per_person": 2}


def _fake_glm(system, user, schema, **kw):
    return schema.model_validate({"messages": [{"role": "user", "content": f"Help please. {user}"},
                                               {"role": "assistant", "content": "Here is an answer."}]}), {}


def _synth(tmp_data, monkeypatch, n=80):
    from logless.providers import glm
    monkeypatch.setattr(reconstruct, "load_mix", lambda: MIX)
    monkeypatch.setattr(glm, "chat_json", _fake_glm)
    out = tmp_data.parent / "synth"
    assert reconstruct.synth(n, out, workers=4) == {"written": n, "failed": 0, "out": str(out)}
    importer.load_jsonl(out / "conversations.jsonl", out / "source.json")
    return [json.loads(line) for line in (out / "truth.jsonl").read_text().splitlines()], out


def _build(truth, assign, lanes, observed):
    """A published-shaped build: cl_math and cl_py leaves, conversations placed by `assign`."""
    b = util.Build(build_id="b_test", limit=None, conv_ids=[], started_at="")
    b.save("structure_final", {
        "categories": [{"id": "cl_cat", "title": "Help"}],
        "leaves": [{"id": "cl_math", "parent_id": "cl_cat", "is_other": False, "theme_ids": ["t_math"], "title": "Math"},
                   {"id": "cl_py", "parent_id": "cl_cat", "is_other": False, "theme_ids": ["t_py"], "title": "Python"},
                   {"id": "cl_other", "parent_id": "cl_cat", "is_other": True, "theme_ids": ["other"], "title": "Other"}]})
    con = db.private()
    with db.write(con):
        for t in truth:
            cid = conversation_id("jsonl:" + t["id"])
            con.execute("INSERT INTO assignments(build_id, conv_id, theme_id, round) VALUES ('b_test', ?, ?, 1)", (cid, assign(t)))
            con.execute("INSERT INTO facets(conv_id, model) VALUES (?, ?)", (cid, lanes(t)))
            con.execute("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, question_version) VALUES (?, 'correction', ?, ?, 1, ?)",
                        (cid, *(["observed"] * 2 if observed(t) else ["not_observed"] * 2), FRICTION_QV))


def test_synth_output_imports_and_keeps_truth_aside(tmp_data, monkeypatch):
    truth, out = _synth(tmp_data, monkeypatch, n=20)
    rows = db.private().execute("SELECT conv_id, language FROM conversations").fetchall()
    assert {r["conv_id"] for r in rows} == {conversation_id("jsonl:" + t["id"]) for t in truth}
    assert "topic" not in (out / "conversations.jsonl").read_text()
    assert {t["topic"] for t in truth} <= {"math", "python"}


def test_scores_a_perfect_and_a_lossy_build(tmp_data, monkeypatch):
    truth, out = _synth(tmp_data, monkeypatch)
    monkeypatch.setattr(reconstruct, "MIN_GROUP", 5)
    py = [t for t in truth if t["topic"] == "python"]
    lost = {t["id"] for t in py[:10]}                        # ten Python chats fall into Other
    false_pos = next(t["id"] for t in truth if not t["correction"])
    _build(truth,
           assign=lambda t: "t_math" if t["topic"] == "math" else ("other" if t["id"] in lost else "t_py"),
           lanes=lambda t: "glm-5.3-flash" if int(t["id"][-2:]) % 2 else "glm-5.3",
           observed=lambda t: t["correction"] or t["id"] == false_pos)

    r = reconstruct.score(out / "truth.jsonl", "b_test")
    n, tp = len(truth), sum(t["correction"] for t in truth)
    assert r["overall"]["conversations"] == n and r["unmatched_truth"] == 0
    assert r["overall"]["tvd"] == round(0.5 * (10 + 10) / n, 4)   # python under-counted by 10, "unassigned" over by 10
    assert 0 < r["overall"]["ari"] < 1
    assert r["overall"]["correction"]["recall"] == 1.0
    assert r["overall"]["correction"]["precision"] == round(tp / (tp + 1), 4)
    assert set(r["by_language"]) == {t["language"] for t in truth}
    assert set(r["by_lane"]) == {"glm-5.3-flash", "glm-5.3"}
    assert sum(g["conversations"] for g in r["by_lane"].values()) == n
    assert {l["id"]: l["topic"] for l in r["leaves"]} == {"cl_math": "math", "cl_py": "python", "cl_other": "unassigned"}
    assert r["missing_topics"] == []
    assert json.loads((tmp_data / "artifacts" / "eval" / "reconstruct.json").read_text()) == r


def test_small_groups_get_no_scores(tmp_data, monkeypatch):
    truth, out = _synth(tmp_data, monkeypatch, n=20)
    _build(truth, assign=lambda t: "t_math", lanes=lambda t: "glm-5.3-flash", observed=lambda t: False)
    r = reconstruct.score(out / "truth.jsonl", "b_test")
    assert r["overall"] == {"conversations": 20}
    assert r["missing_topics"] == (["python"] if any(t["topic"] == "python" for t in truth) else [])
