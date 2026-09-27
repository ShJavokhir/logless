from logless.pipeline.describe import COMMON_PEOPLE, support_label
from logless.pipeline.stats import languages_of, metrics_of, reference_metrics


def _row(i, user, leaf, cat, lang="English", **sig):
    d = {"conv_id": f"c{i}", "user_id": user, "language": lang, "leaf_id": leaf, "category_id": cat,
         "correction": "not_observed", "repeat_request": "not_observed", "assistant_limit": "not_observed",
         "complaint": "not_observed"}
    d.update(sig)
    return d


CLUSTERS = [
    {"id": "cl_a", "parent_id": "cat_x", "level": 2, "is_other": False, "theme_ids": ["t1"]},
    {"id": "cl_b", "parent_id": "cat_x", "level": 2, "is_other": False, "theme_ids": ["t2"]},
    {"id": "cl_other", "parent_id": "cat_o", "level": 2, "is_other": True, "theme_ids": ["other"]},
    {"id": "cat_x", "parent_id": None, "level": 1, "is_other": False, "theme_ids": ["t1", "t2"]},
    {"id": "cat_o", "parent_id": None, "level": 1, "is_other": True, "theme_ids": ["other"]},
]


def test_reference_metrics_unions_and_users_not_summed():
    rows = [_row(1, "u1", "cl_a", "cat_x", correction="observed"),
            _row(2, "u1", "cl_b", "cat_x", complaint="unclear"),
            _row(3, "u2", "cl_b", "cat_x", repeat_request="observed", complaint="observed"),
            _row(4, "u3", "cl_other", "cat_o")]
    m = reference_metrics(rows, CLUSTERS)
    assert m["total"]["conversations"] == 4 and m["total"]["users"] == 3
    assert m["cl_a"]["users"] == 1 and m["cl_b"]["users"] == 2
    assert m["cat_x"]["users"] == 2  # u1 appears in both leaves: recomputed, not summed (1 + 2)
    assert m["cat_x"]["conversations"] == m["cl_a"]["conversations"] + m["cl_b"]["conversations"]
    assert sum(m[c]["conversations"] for c in ("cl_a", "cl_b", "cl_other")) == m["total"]["conversations"]
    fb = m["cl_b"]["friction"]
    assert fb["conversations"] == 1 and fb["unclear"] == 1  # unclear only when nothing observed
    assert fb["signals"] == {"correction": 0, "repeat_request": 1, "assistant_limit": 0, "complaint": 1}
    assert fb["share"] == 0.5
    assert m["cl_a"]["share"] == 0.25


def test_friction_share_null_for_empty_node():
    assert metrics_of([], 10)["friction"]["share"] is None


def test_languages_rule():
    rows = []
    i = 0
    def add(lang, n, people):
        nonlocal i
        for k in range(n):
            rows.append(_row(i, f"{lang}-{k % people}", "cl_a", "cat_x", lang=lang))
            i += 1
    add("English", 20, 10)
    add("Chinese", 8, 4)
    add("Russian", 6, 2)     # >= 5 conversations but only 2 people -> folds into Other
    add("French", 4, 4)      # only 4 conversations -> folds
    add("German", 5, 3)
    add("Spanish", 5, 3)
    add("Italian", 5, 3)
    add("Turkish", 5, 3)     # 6th qualifying language -> folds (top 5 only)
    out = languages_of(rows)
    names = [l["name"] for l in out]
    assert names[:2] == ["English", "Chinese"]
    assert "Russian" not in names and "French" not in names
    assert len([n for n in names if n != "Other languages"]) == 5
    assert names[-1] == "Other languages"
    assert sum(l["conversations"] for l in out) == len(rows)


def test_languages_no_other_entry_when_nothing_folds():
    rows = [_row(i, f"u{i}", "cl_a", "cat_x") for i in range(6)]
    assert languages_of(rows) == [{"name": "English", "conversations": 6}]


def test_support_rule():
    facets = {f"c{i}": {"user_id": f"u{i % 4}"} for i in range(10)}
    assert support_label([f"c{i}" for i in range(10)], facets) == "observed"  # 10 conversations, 4 people
    facets = {f"c{i}": {"user_id": f"u{i}"} for i in range(10)}
    assert support_label([f"c{i}" for i in range(COMMON_PEOPLE)], facets) == "common"
    assert support_label([f"c{i}" for i in range(COMMON_PEOPLE - 1)], facets) == "observed"
