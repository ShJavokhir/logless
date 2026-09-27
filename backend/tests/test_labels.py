from logless.pipeline.labels import _fallback, label_problems, validate_labels


def test_label_shape_rules():
    assert label_problems("Systems code") == []
    assert label_problems("Probing the AI") == []
    assert label_problems("Q&A help") == []
    assert "longer than 22 characters" in label_problems("Extraordinarily verbose label")
    assert "more than 3 words" in label_problems("Write web front ends")
    assert "contains a number" in label_problems("Top 10 lists")
    assert label_problems("") == ["empty"]
    assert any("punctuation" in p for p in label_problems("Code: help"))


def test_labels_unique_across_nodes_case_insensitive():
    probs = validate_labels({"a": "Systems code", "b": "systems code", "c": "Web front ends"}, ["a", "b", "c", "d"])
    assert set(probs) == {"a", "b", "d"}
    assert probs["d"] == ["missing"]


def test_fallback_label_is_short_and_distinct():
    used = {"write and debug"}
    lab = _fallback("Write and debug systems-level code", used)
    assert lab.casefold() not in used and len(lab) <= 22 and len(lab.split()) <= 3
    assert label_problems(_fallback("Answers to 3 homework problems", set())) == []


def test_no_cache_env_bypasses_llm_cache_reads(tmp_data, monkeypatch):
    from logless.providers.http import cache_get, cache_put
    cache_put("k1", "glm", "m", {"content": "x"})
    assert cache_get("k1") == {"content": "x"}
    monkeypatch.setenv("LOGLESS_NO_CACHE", "1")
    assert cache_get("k1") is None
    from logless.pipeline import util
    assert util.no_cache()
