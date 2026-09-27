import json
import re
from pathlib import Path

import numpy as np
import pytest

from logless import db
from logless.data import importer
from logless.pipeline import discover, prompts, run, util


PUBLIC_METADATA = {
    "name": "Support pilot", "workspace_name": "Support assistant",
    "workspace_description": "A synthetic customer support experiment.",
    "source_url": "https://example.org/datasets/support", "revision": "pilot-v1",
    "license": "Team-owned synthetic data", "attribution": "Created by the project team",
    "people_note": "People are distinct source user IDs, which may represent shared accounts.",
    "intended_uses": ["Answer product support questions"],
}


def _files(tmp_data, rows=None, metadata=None):
    # Inputs live outside the deliberately empty destination directory.
    source = tmp_data.parent / "conversations.jsonl"
    meta = tmp_data.parent / "source.json"
    rows = rows if rows is not None else [
        {"id": "one", "user_id": "person-one", "language": "English", "timestamp": "2026-01-01T00:00:00Z",
         "messages": [{"role": "user", "content": "How do I return a product?"}, {"role": "assistant", "content": "Use the return form."}]},
        {"id": "two", "user_id": "person-one", "language": "Spanish",
         "messages": [{"role": "user", "content": "Quiero devolver el producto."}]},
        {"id": "three", "user_id": "person-two", "language": "Japanese",
         "messages": [{"role": "user", "content": "返品する方法を知りたい。"}]},
    ]
    source.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows))
    meta.write_text(json.dumps(metadata or PUBLIC_METADATA))
    return source, meta


def test_import_is_atomic_pseudonymous_and_uses_explicit_metadata(tmp_data):
    source, meta = _files(tmp_data)
    result = importer.load_jsonl(source, meta)
    assert result["conversations"] == 3 and result["users"] == 2 and result["truncated"] == 0
    rows = db.private().execute("SELECT * FROM conversations ORDER BY sample_rank").fetchall()
    assert rows[0]["user_id"] == rows[1]["user_id"] != rows[2]["user_id"]
    assert all(re.fullmatch(r"c_[0-9a-f]{12}", r["conv_id"]) for r in rows)
    assert all(re.fullmatch(r"u_[0-9a-f]{10}", r["user_id"]) for r in rows)
    assert {r["language"] for r in rows} == {"English", "Spanish", "Japanese"}
    assert importer.metadata()["name"] == "Support pilot"
    assert importer.metadata()["adapter"] == "jsonl-v1"
    with pytest.raises(importer.ImportError, match="empty data directory"):
        importer.load_jsonl(source, meta)


@pytest.mark.parametrize("bad", [
    {"id": "bad", "user_id": "private@example.invalid", "messages": []},
    {"id": "bad", "user_id": "private@example.invalid", "messages": [{"role": "user", "content": []}]},
    {"id": "bad", "user_id": "private@example.invalid", "messages": [{"role": "assistant", "content": "x"}]},
    {"id": "bad", "user_id": "private@example.invalid", "messages": [{"role": "user", "content": "x"}], "timestamp": "2026-01-01"},
])
def test_bad_import_leaves_destination_empty_without_echoing_records(tmp_data, bad):
    source, meta = _files(tmp_data, rows=[bad])
    with pytest.raises(importer.ImportError) as error:
        importer.load_jsonl(source, meta)
    assert "private@example.invalid" not in str(error.value)
    assert list(tmp_data.iterdir()) == []


def test_duplicate_ids_are_rejected_before_writes(tmp_data):
    row = {"id": "same", "user_id": "someone", "messages": [{"role": "user", "content": "Hello"}]}
    source, meta = _files(tmp_data, rows=[row, row])
    with pytest.raises(importer.ImportError, match="duplicate"):
        importer.load_jsonl(source, meta)
    assert list(tmp_data.iterdir()) == []


@pytest.mark.parametrize("url", ["javascript:alert(1)", "https://user:secret@example.org/", "https://example.org/?token=private"])
def test_metadata_rejects_unsafe_attribution_urls(tmp_data, url):
    source, meta = _files(tmp_data, metadata={**PUBLIC_METADATA, "source_url": url})
    with pytest.raises(importer.ImportError, match="invalid public metadata"):
        importer.load_jsonl(source, meta)
    assert list(tmp_data.iterdir()) == []


def _models(system, user, schema, **kwargs):
    if schema is prompts.Facets:
        return schema(user_goal="Return a purchased product", task="Request product return instructions", domain="product returns", language="English")
    if schema is prompts.ClusterName:
        return schema(name="Return purchased products", description="People seek help with product returns.", includes="return instructions", excludes="new purchases")
    if schema is prompts.Consolidation:
        return schema(themes=[{"name": "Return purchased products", "description": "Product return help.",
                               "includes": "return instructions", "excludes": "new purchases", "clusters": ["k1_00"]}])
    if schema is prompts.Hierarchy:
        assert "1 to 1" in system
        return schema(categories=[{"title": "Purchase support", "description": "Support after a purchase.", "themes": ["L1"]}])
    if schema is prompts.Description:
        return schema(title="Return purchased products", description="People request help returning products.", needs=[
            {"text": "Understand the return process", "evidence": ["r1"]},
            {"text": "Find the return form", "evidence": ["r1"]}], problems=[])
    if schema is prompts.CategoryTexts:
        return schema(categories=[{"id": json.loads(line)["id"], "title": "Purchase support", "description": "Support after a purchase."}
                                  for line in user.splitlines()])
    if schema is prompts.Audit:
        return schema(items=[{"key": key, "verdict": "pass"} for key in re.findall(r'"key": "([^"]+)"', user)])
    if schema is prompts.ShortLabels:
        nodes = json.loads(user.split("\n", 1)[1])["nodes"]
        return schema(items=[{"key": node["key"], "short_title": "Purchase help" if node["level"] == "category" else "Product returns"}
                             for node in nodes])
    raise AssertionError(f"unexpected model schema {schema.__name__}")


def _decisions(state, questions):
    answers = {}
    for key, question in questions.items():
        kind = question["type"]
        if kind == "noul":
            answers[key] = {"type": kind, "noul": 0.0}
        elif kind == "score":
            answers[key] = {"type": kind, "score": 0.0, "probabilities": {str(i): float(i == 0) for i in range(len(question["criteria"]))}}
        else:
            options = list(question["criteria"])
            selected = "not_observed" if "not_observed" in options else options[0]
            answers[key] = {"type": kind, "choice": selected, "probabilities": {o: float(o == selected) for o in options}}
    return answers


def test_imported_duplicate_only_multilingual_dataset_runs_all_stages(tmp_data, monkeypatch):
    source, meta = _files(tmp_data)
    importer.load_jsonl(source, meta)
    monkeypatch.setattr(util, "glm_json", _models)
    monkeypatch.setattr(util, "jev_ask", _decisions)
    monkeypatch.setattr(discover.fireworks, "embed", lambda texts: np.tile(np.array([[1.0, 0.0]], dtype=np.float32), (len(texts), 1)))
    monkeypatch.setattr("logless.eval.summary.write_summary", lambda *a, **k: None)
    assert run.main() == 0
    snap = json.loads(db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()["json"])
    assert snap["dataset"]["name"] == "Support pilot"
    assert snap["dataset"]["source_url"] == PUBLIC_METADATA["source_url"]
    assert snap["workspace"]["name"] == "Support assistant"
    assert snap["intended_uses"] == PUBLIC_METADATA["intended_uses"]
    assert snap["totals"]["conversations"] == 3 and snap["totals"]["users"] == 2
    assert snap["dataset"]["languages"] == 3
    assert len(snap["clusters"]) == 2 and len(snap["categories"]) == 2
    assert snap["dataset"]["fixtures"] == {"canary_conversations": 0, "injection_conversations": 0}
    build = run.load_build()
    assert build.load("discover_r1")["subset"] == 1
    assert build.load("discover_r1")["k"] == 1
    assert [s["stage"] for s in build.stages] == run.STAGE_NAMES


def test_empty_build_fails_before_provider_calls(tmp_data):
    with pytest.raises(SystemExit, match="no conversations"):
        run.main()


def test_import_rejects_oversized_lines_before_parsing(tmp_data, monkeypatch):
    source, meta = _files(tmp_data)
    monkeypatch.setattr(importer, "MAX_LINE_BYTES", 64)
    with pytest.raises(importer.ImportError, match="record limit"):
        importer.load_jsonl(source, meta)
    assert list(tmp_data.iterdir()) == []


@pytest.mark.parametrize("text", ['{"id":"one","id":"two"}', '{"id":NaN}'])
def test_import_rejects_ambiguous_json(tmp_data, text):
    source, meta = _files(tmp_data)
    source.write_text(text)
    with pytest.raises(importer.ImportError):
        importer.load_jsonl(source, meta)
    assert list(tmp_data.iterdir()) == []


def test_theme_consolidation_deduplicates_members_and_reserves_catchall():
    named = [{"id": "k1_00", "name": "Return products", "description": "Return help", "includes": "returns", "excludes": "purchases"}]
    themes = discover.fix_coverage(named, [{**named[0], "name": "Other or unclear", "clusters": ["k1_00", "k1_00"]}])
    assert themes[0]["clusters"] == ["k1_00"]
    assert themes[0]["name"] != "Other or unclear"


def test_duplicate_theme_choices_and_assignments_fail_closed():
    from logless.pipeline.questions import theme_question
    from logless.pipeline.stats import clusters_for
    with pytest.raises(ValueError, match="unique names"):
        theme_question([{"name": "Returns"}, {"name": "Returns"}])
    with pytest.raises(ValueError, match="exactly one leaf"):
        clusters_for({"leaves": [{"theme_ids": ["t1"]}, {"theme_ids": ["t1"]}]})


@pytest.mark.parametrize("label,expected", [
    ("en-US", "English"), ("pt_BR", "Portuguese"), ("zh-Hant-TW", "Chinese"),
    ("JA", "Japanese"), (" spanish ", "Spanish"), ("Norwegian Bokmål", "Norwegian Bokmål"),
    (None, "Unknown"), ("Unknown", "Unknown"), ("private unrelated text", "Unknown"),
])
def test_import_language_uses_a_closed_public_vocabulary(tmp_data, label, expected):
    row = {"id": "row", "user_id": "person", "language": label,
           "messages": [{"role": "user", "content": "Return a product."}]}
    source, meta = _files(tmp_data, rows=[row])
    importer.load_jsonl(source, meta)
    assert db.private().execute("SELECT language FROM conversations").fetchone()["language"] == expected


def test_sensitive_freeform_language_never_reaches_published_snapshot(tmp_data, monkeypatch):
    from logless.api.serializers import serialize_snapshot
    sensitive = "I need to escape an abusive partner"
    rows = [{"id": str(i), "user_id": str(i), "language": sensitive,
             "messages": [{"role": "user", "content": "Return a product."}]} for i in range(6)]
    source, meta = _files(tmp_data, rows=rows)
    importer.load_jsonl(source, meta)
    monkeypatch.setattr(util, "glm_json", _models)
    monkeypatch.setattr(util, "jev_ask", _decisions)
    monkeypatch.setattr(discover.fireworks, "embed", lambda texts: np.tile(np.array([[1.0, 0.0]], dtype=np.float32), (len(texts), 1)))
    monkeypatch.setattr("logless.eval.summary.write_summary", lambda *a, **k: None)
    assert run.main() == 0
    snap = json.loads(db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()["json"])
    assert snap["totals"]["users"] == 6 and snap["totals"]["conversations"] == 6
    assert snap["totals"]["languages"] == [{"name": "Unknown", "conversations": 6}]
    assert snap["dataset"]["languages"] == 0
    assert sensitive not in json.dumps(snap, ensure_ascii=False)
    assert sensitive not in json.dumps(serialize_snapshot(snap), ensure_ascii=False)


def test_identifiers_preserve_whitespace_and_distinct_user_identity(tmp_data):
    rows = [{"id": value, "user_id": value, "messages": [{"role": "user", "content": "Return a product."}]}
            for value in ("customer", " customer ")]
    source, meta = _files(tmp_data, rows=rows)
    result = importer.load_jsonl(source, meta)
    assert result["conversations"] == 2 and result["users"] == 2
    stored = db.private().execute("SELECT conv_id,user_id FROM conversations").fetchall()
    assert stored[0]["conv_id"] != stored[1]["conv_id"]
    assert stored[0]["user_id"] != stored[1]["user_id"]


@pytest.mark.parametrize("field", ["id", "user_id", "language", "model", "timestamp", "content"])
@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
def test_lone_surrogate_in_records_rejected_before_database_open(tmp_data, field, surrogate):
    source, meta = _files(tmp_data)
    row = {"id": "row", "user_id": "person", "messages": [{"role": "user", "content": "Return a product."}]}
    value = "private-record-value" + surrogate
    if field == "content":
        row["messages"][0]["content"] = value
    else:
        row[field] = value
    source.write_text(json.dumps(row, ensure_ascii=True))
    with pytest.raises(importer.ImportError) as error:
        importer.load_jsonl(source, meta)
    assert "private-record-value" not in str(error.value)
    assert list(tmp_data.iterdir()) == []


@pytest.mark.parametrize("field", list(PUBLIC_METADATA))
def test_lone_surrogate_in_metadata_rejected_before_database_open(tmp_data, field):
    source, meta = _files(tmp_data)
    values = {**PUBLIC_METADATA, field: ["private-metadata\ud800"] if field == "intended_uses" else "private-metadata\ud800"}
    meta.write_text(json.dumps(values, ensure_ascii=True))
    with pytest.raises(importer.ImportError) as error:
        importer.load_jsonl(source, meta)
    assert "private-metadata" not in str(error.value)
    assert list(tmp_data.iterdir()) == []


def test_valid_escaped_surrogate_pair_is_accepted(tmp_data):
    source, meta = _files(tmp_data)
    row = {"id": "row", "user_id": "person", "messages": [{"role": "user", "content": "Explain this symbol: 😀"}]}
    source.write_text(json.dumps(row, ensure_ascii=True))
    assert importer.load_jsonl(source, meta)["conversations"] == 1
    assert "😀" in db.private().execute("SELECT text FROM conversations").fetchone()["text"]
