"""DEV FIXTURE ONLY — writes a plausible published snapshot plus matching private rows for a fake
build, so analyses, containment, stories and search can be exercised end to end before the
pipeline publishes a real snapshot.

Everything it writes is fake and labelled as such: ~300 conversations with NO text (model
"dev-fixture"), invented cluster titles, fake canary tokens. It never touches the real data dir:

    LOGLESS_DATA_DIR defaults to <repo>/var-dev here, `<repo>/var` is refused outright, the script
    refuses to run if LOGLESS_ENV=production, and it refuses if the target private.db already holds
    any conversation that is not a dev-fixture row.

Usage:  backend/.venv/bin/python backend/scripts/dev_snapshot.py [--data-dir PATH] [--n 300]
Then:   LOGLESS_DATA_DIR=var-dev backend/.venv/bin/logless serve
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEV_MODEL = "dev-fixture"

TAXONOMY = {
    "Writing and editing": {
        "Drafting emails and messages": (["Write a polite message that gets a clear reply", "Adjust the tone of a draft"],
                                         [("Replies ignore the requested tone", "correction"), ("Drafts come back too long", "repeat_request")]),
        "Creative stories and roleplay": (["Continue a story in a consistent style", "Invent characters and settings"],
                                          [("The assistant refuses some story directions", "assistant_limit")]),
        "Essays and academic writing": (["Structure an essay around a thesis", "Paraphrase a passage in simpler words"],
                                        [("Citations are invented or wrong", "correction"), ("Word limits are not respected", "complaint")]),
    },
    "Programming help": {
        "Debugging code errors": (["Find why a program crashes", "Fix an error message"],
                                  [("Suggested fixes introduce new errors", "correction"), ("The same fix is repeated", "repeat_request")]),
        "Writing scripts and small programs": (["Automate a repetitive task", "Get a working example quickly"],
                                               [("Generated code uses outdated libraries", "correction")]),
        "Explaining programming concepts": (["Understand a concept step by step", "Compare two approaches"], []),
    },
    "Learning and questions": {
        "Homework and exam questions": (["Check an answer with reasoning", "Understand a worked solution"],
                                        [("Arithmetic mistakes in worked answers", "correction")]),
        "Translating text": (["Translate a message naturally", "Keep names and formatting intact"],
                             [("Translations lose the original meaning", "complaint")]),
        "General knowledge questions": (["Get a quick factual answer", "Learn the background of a topic"],
                                        [("No access to current events", "assistant_limit")]),
    },
    "Work and business": {
        "Marketing copy and product descriptions": (["Write catchy product copy", "Generate slogan options"],
                                                    [("Copy sounds generic", "complaint")]),
        "Resumes and cover letters": (["Tailor a resume to a job post", "Write a short cover letter"],
                                      [("Letters exaggerate experience", "correction")]),
        "Business plans and strategy": (["Outline a plan for a small venture", "List risks and next steps"], []),
    },
    "Personal and everyday": {
        "Advice on relationships and life": (["Think through a difficult conversation", "Get a second opinion"],
                                             [("Advice feels generic", "complaint")]),
        "Health and fitness questions": (["Plan a simple workout routine", "Understand general nutrition advice"],
                                         [("The assistant declines medical specifics", "assistant_limit")]),
        "Planning trips and events": (["Draft an itinerary", "Compare options within a budget"],
                                      [("No live prices or availability", "assistant_limit"), ("Plans need several rounds of edits", "repeat_request")]),
    },
    # The catch-all leaf lives in its own category, both flagged is_other (as the pipeline publishes it).
    "Other": {
        "Other or unclear": (["Requests that fit no published workflow"], []),
    },
}
WEIGHTS = [9, 7, 6, 11, 7, 4, 8, 6, 7, 5, 3, 2, 4, 3, 4, 5]
LANGS = [("English", 0.62), ("Chinese", 0.14), ("Russian", 0.08), ("Spanish", 0.05), ("French", 0.04), ("German", 0.03),
         ("Portuguese", 0.02), ("Arabic", 0.01), ("Japanese", 0.01)]
SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")


def hx(seed: str, n: int = 6) -> str:
    return hashlib.sha256(("devfixture:" + seed).encode()).hexdigest()[:n]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=str(REPO / "var-dev"))
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if os.environ.get("LOGLESS_ENV") == "production":
        print("refusing: LOGLESS_ENV=production (dev fixtures must never run in production)", file=sys.stderr)
        return 2
    data_dir = Path(args.data_dir).resolve()
    if data_dir == (REPO / "var").resolve() or data_dir == Path("/var/lib/logless"):
        print(f"refusing: {data_dir} is a real data dir; use var-dev", file=sys.stderr)
        return 2
    os.environ["LOGLESS_DATA_DIR"] = str(data_dir)  # before settings() is first called

    sys.path.insert(0, str(REPO / "backend"))
    from logless import db, ids
    from logless.config import settings
    from logless.sandbox import reference
    from logless.sandbox.export import export_inputs, save_cluster_map
    try:
        from logless.pipeline.questions import FRICTION_QV
    except ImportError:
        FRICTION_QV = "f1"

    assert settings().data_dir == data_dir
    con = db.private()
    real = con.execute("SELECT COUNT(*) FROM conversations WHERE model IS NOT ?", (DEV_MODEL,)).fetchone()[0]
    if real:
        print(f"refusing: {data_dir}/private.db holds {real} non-fixture conversations", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    build_id = ids.build_id()
    snap_id = ids.snapshot_id()
    now = ids.utcnow()

    # ------------------------------------------------ clusters (theme t_<leaf> -> leaf)
    clusters, cats, leaves = [], [], []
    for cat_title, leaf_map in TAXONOMY.items():
        cid = "cat_" + hx(cat_title)
        cat_other = cat_title == "Other"
        cats.append({"id": cid, "title": cat_title, "other": cat_other})
        clusters.append({"id": cid, "parent_id": None, "level": 1, "is_other": cat_other, "theme_ids": []})
        for leaf_title, (needs, problems) in leaf_map.items():
            other = leaf_title == "Other or unclear"
            lid = "cl_other" if other else "cl_" + hx(leaf_title)
            leaves.append({"id": lid, "parent": cid, "title": leaf_title, "needs": needs, "problems": problems, "other": other})
            clusters.append({"id": lid, "parent_id": cid, "level": 2, "is_other": other,
                             "theme_ids": ["other"] if other else [f"t_{hx(leaf_title, 8)}"]})

    # ------------------------------------------------ private rows (no text)
    users = [f"u_{hx('user' + str(i), 10)}" for i in range(max(20, args.n // 4))]
    rows = []
    for i in range(args.n):
        leaf = rng.choices(leaves, weights=WEIGHTS)[0]
        lang = rng.choices([x for x, _ in LANGS], weights=[w for _, w in LANGS])[0]
        rows.append((f"c_{hx('conv' + str(i), 12)}", leaf, rng.choice(users[: rng.randint(10, len(users))]), lang))
    with db.write(con):
        con.execute("DELETE FROM conversations WHERE model = ?", (DEV_MODEL,))
        for tbl in ("friction", "assignments", "eval_fixtures"):
            con.execute(f"DELETE FROM {tbl} WHERE conv_id LIKE 'c_%' AND conv_id IN (SELECT conv_id FROM {tbl})")
        con.execute("DELETE FROM builds WHERE status = 'dev_fixture'")
        for i, (cid, leaf, uid, lang) in enumerate(rows):
            con.execute("INSERT INTO conversations(conv_id, turn_identifier, source_row, sample_rank, user_id, language, turns, model, "
                        "country, ts, text, is_fixture) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)",
                        (cid, -(i + 1), None, i, uid, lang, rng.randint(1, 8), DEV_MODEL, None, None, "[dev fixture: no text]"))
            theme = "other" if leaf["other"] else f"t_{hx(leaf['title'], 8)}"
            con.execute("INSERT INTO assignments(build_id, conv_id, theme_id, p, round) VALUES (?,?,?,?,1)", (build_id, cid, theme, 0.9))
            base = 0.08 + 0.12 * len(leaf["problems"])
            for s in SIGNALS:
                r = rng.random()
                choice = "observed" if r < base * (0.6 if s == "complaint" else 1) else ("unclear" if r > 0.93 else "not_observed")
                con.execute("INSERT INTO friction(conv_id, signal, choice, raw_choice, p, model, question_version, created_at) "
                            "VALUES (?,?,?,?,?,?,?,?)", (cid, s, choice, choice, 0.8, DEV_MODEL, FRICTION_QV, now))
        for j, (cid, _, _, _) in enumerate(rows[:2]):
            con.execute("INSERT INTO eval_fixtures(conv_id, kind, tokens_json) VALUES (?,?,?)",
                        (cid, "canary", json.dumps([f"Zyxquor Fenwhistle{j}", f"zyxquor.fenwhistle{j}@example.invalid"])))
        con.execute("INSERT INTO builds(build_id, started_at, finished_at, status, stages_json, snapshot_id) VALUES (?,?,?,?,?,?)",
                    (build_id, now, now, "dev_fixture", "[]", snap_id))

    # ------------------------------------------------ metrics via the trusted reference (same code the gate uses)
    inputs = export_inputs(build_id, clusters)
    agg = reference.rounded(reference.aggregate(inputs.df, inputs.clusters, snap_id))
    nodes = {n["id"]: n for n in agg["nodes"]}
    conv_lang = {cid: lang for cid, _, _, lang in rows}
    conv_user = {cid: uid for cid, _, uid, _ in rows}
    conv_leaf = {cid: leaf["id"] for cid, leaf, _, _ in rows}
    parent = {lf["id"]: lf["parent"] for lf in leaves}

    def languages(member) -> list[dict]:
        from collections import defaultdict
        per = defaultdict(set)
        for cid in [c for c in conv_lang if member(c)]:
            per[conv_lang[cid]].add(cid)
        shown = []
        folded = 0
        for lang, cs in sorted(per.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if len(cs) >= 5 and len({conv_user[c] for c in cs}) >= 3 and len(shown) < 5:
                shown.append({"name": lang, "conversations": len(cs)})
            else:
                folded += len(cs)
        if folded:
            shown.append({"name": "Other languages", "conversations": folded})
        return shown

    def metrics(node_id: str | None) -> dict:
        m = dict(agg["totals"] if node_id is None else {k: v for k, v in nodes[node_id].items() if k != "id"})
        if node_id is None:
            m["languages"] = languages(lambda c: True)
        elif node_id.startswith("cat_"):
            m["languages"] = languages(lambda c: parent[conv_leaf[c]] == node_id)
        else:
            m["languages"] = languages(lambda c: conv_leaf[c] == node_id)
        return m

    cat_nodes = []
    for c in cats:
        kids = [lf["id"] for lf in leaves if lf["parent"] == c["id"]]
        cat_nodes.append({**metrics(c["id"]), "id": c["id"], "level": 1, "parent_id": None, "title": c["title"],
                          "description": f"[dev fixture] Conversations about {c['title'].lower()}.", "children": kids,
                          "is_other": c["other"]})
    leaf_nodes = []
    for lf in leaves:
        m = metrics(lf["id"])
        probs = [{"id": f"p{k}", "text": t, "signal": s, "support": "common" if m["conversations"] >= 25 else "observed"}
                 for k, (t, s) in enumerate(lf["problems"], 1)]
        leaf_nodes.append({**m, "id": lf["id"], "level": 2, "parent_id": lf["parent"], "title": lf["title"],
                           "description": f"[dev fixture] People ask the assistant for help with {lf['title'].lower()}.",
                           "needs": [{"id": f"n{k}", "text": t} for k, t in enumerate(lf["needs"], 1)],
                           "problems": probs,
                           "surprising": {"flag": lf["title"] in ("Health and fitness questions", "Advice on relationships and life"),
                                          "score": 0.8 if lf["title"] in ("Health and fitness questions", "Advice on relationships and life") else 0.1},
                           "is_other": lf["other"]})

    snapshot = {
        "snapshot_id": snap_id, "created_at": now,
        "workspace": {"name": "DEV FIXTURE — not real data",
                      "description": "Synthetic development fixture written by backend/scripts/dev_snapshot.py. No conversation text exists."},
        "dataset": {"name": "WildChat-1M (dev fixture stand-in)", "source_url": "https://huggingface.co/datasets/allenai/WildChat-1M",
                    "revision": "dev-fixture", "license": "ODC-BY-1.0",
                    "attribution": 'Zhao et al., "WildChat: 1M ChatGPT Interaction Logs in the Wild", ICLR 2024',
                    "period_start": "2023-04-08", "period_end": "2023-05-04",
                    "conversations": agg["total_conversations"], "users": agg["totals"]["users"],
                    "languages": len(set(conv_lang.values())),
                    "sample_note": f"DEV FIXTURE: {args.n} fake conversations with no text, for local development only.",
                    "fixtures": {"canary_conversations": 2}},
        "totals": metrics(None),
        "categories": cat_nodes,
        "clusters": leaf_nodes,
        "intended_uses": ["writing help", "coding help", "answering questions"],
        "provenance": {"pipeline_version": "dev-fixture", "dataset_hash": "dev-fixture",
                       "models": {"facets": "glm-5.3-flash", "naming": "glm-5.3", "classification": "jev-latest",
                                  "embeddings": "fireworks/qwen3-embedding-8b", "analysis_code": "glm-5.3", "explanation": "glm-5.3",
                                  "story": "glm-5.3", "relevance": "jev-latest"},
                       "prompt_versions": {"facets": "dev"}, "discovery_rounds": 0, "build_seconds": 0,
                       "stages": [{"stage": "dev_fixture", "started_at": now, "finished_at": now,
                                   "counts": {"conversations": args.n}, "models": []}]},
    }
    assert sum(n["conversations"] for n in leaf_nodes) == snapshot["totals"]["conversations"]

    pub = db.public()
    with db.write(pub):
        pub.execute("UPDATE snapshots SET is_current=0")
        pub.execute("INSERT INTO snapshots(snapshot_id, created_at, json, is_current) VALUES (?,?,?,1)",
                    (snap_id, now, json.dumps(snapshot)))
        pub.execute("INSERT OR REPLACE INTO eval_reports(snapshot_id, json, created_at) VALUES (?,?,?)", (snap_id, json.dumps({
            "snapshot_id": snap_id, "generated_at": now,
            "checks": [{"id": "dev_fixture", "name": "Dev fixture (no real evaluation)", "value": "n/a", "target": "n/a",
                        "passed": None, "detail": "This report is a placeholder written by dev_snapshot.py."}]}), now))
    save_cluster_map(snap_id, build_id, clusters)
    print(json.dumps({"data_dir": str(data_dir), "snapshot_id": snap_id, "build_id": build_id,
                      "conversations": args.n, "categories": len(cat_nodes), "leaves": len(leaf_nodes)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
