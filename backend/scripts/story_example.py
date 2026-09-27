"""Follow ONE synthetic conversation through the real pipeline functions and write a JSON record of every
step, for the presentation screen "from one transcript up to the hierarchy".

Run on the app VM as the logless user (it needs the provider keys and LOGLESS_DATA_DIR from /etc/logless/env):
    cd /opt/logless/backend && sudo -u logless bash -c 'set -a; . /etc/logless/env; set +a; \\
        .venv/bin/python scripts/story_example.py --out /tmp/story_example.json'

Nothing is stored:
- private.db and public.db are opened read-only (SQLite `mode=ro`, else `PRAGMA query_only=ON`) and those
  handles are installed as `db.private()` / `db.public()` for this thread, so every lookup is a SELECT and
  any write would raise. `db.write` is also replaced by a function that raises.
- The provider response cache (`llm_cache`) is bypassed at every import site (reads return None, writes
  are no-ops), so `util.glm_json`, `util.jev_ask` and `facets._pii` run unmodified with fresh model calls.
- `facets.extract_one` / `friction_one` (which INSERT) are not called; their steps are called one by one.
  `ensure_schema()` is never called. The embedding goes straight to `fireworks.embed` (no embedding_cache).
- Build embeddings are read from data_dir/embeddings; if they are missing the script stops instead of
  letting `discover.load_embeddings` rebuild (and cache) them.

The output holds the synthetic transcript, the model outputs for it, and aggregates only for the real
corpus: neighbour counts per leaf and the top similarity, never neighbour ids or text."""
from __future__ import annotations

import argparse
import contextlib
import json
import logging
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import numpy as np

log = logging.getLogger("logless.story_example")

NOTE = "Synthetic conversation written for the demo, run through the same pipeline functions; nothing was stored."
FAKE_NAME = ("Dana", "Whitfield")
FAKE_COMPANY = "Brightwater"
NEIGHBOURS_K = 25

# Invented person and company. No contact details, URLs, handles, paths, dates, long digit runs or
# fixture tokens: the public web bundle is scanned for those (checked at start-up and in tests).
TRANSCRIPT: list[tuple[str, str]] = [
    ("user", "Hi, I'm Dana Whitfield and I put together the weekly operations numbers at Brightwater Logistics. "
             "I export our shipments to a CSV with the columns shipment_id, origin, destination, weight_kg and status. "
             "Can you write a Python script that reads that file and prints the total weight per destination, "
             "counting only shipments whose status is delivered?"),
    ("assistant", "Sure! Here is a short script using the csv module:\n\n"
                  "```python\n"
                  "import csv\n"
                  "from collections import defaultdict\n\n"
                  "totals = defaultdict(float)\n"
                  "with open('shipments.csv', newline='') as f:\n"
                  "    for row in csv.DictReader(f):\n"
                  "        if row['status'] == 'delivered':\n"
                  "            totals[row['destination']] += row['weight_kg']\n\n"
                  "for destination, weight in totals.items():\n"
                  "    print(destination, weight)\n"
                  "```\n\n"
                  "It groups the delivered shipments by destination and adds up their weights."),
    ("user", "That doesn't work. It crashes on the first delivered row with \"TypeError: unsupported operand "
             "type(s) for +=: 'float' and 'str'\". Also some rows in our export say Delivered with a capital D "
             "and those would be skipped. Please give me the script again: total weight per destination, "
             "delivered shipments only."),
    ("assistant", "You're right, sorry about that. The csv module returns every value as a string, so the weight "
                  "has to be converted to a number before it is added, and the status should be compared without "
                  "caring about case or stray spaces. Here is a corrected version:\n\n"
                  "```python\n"
                  "import csv\n"
                  "from collections import defaultdict\n\n"
                  "totals = defaultdict(float)\n"
                  "with open('shipments.csv', newline='') as f:\n"
                  "    for row in csv.DictReader(f):\n"
                  "        if row['status'].strip().lower() != 'delivered':\n"
                  "            continue\n"
                  "        weight = row['weight_kg'].strip()\n"
                  "        if not weight:\n"
                  "            continue  # skip rows with no weight recorded\n"
                  "        totals[row['destination'].strip()] += float(weight)\n\n"
                  "for destination, weight in totals.items():\n"
                  "    print(f'{destination}: {weight:.1f} kg')\n"
                  "```\n\n"
                  "Rows with an empty weight are skipped instead of stopping the script."),
    ("user", "That one works, thank you. Could it also sort the destinations by total weight, heaviest first?"),
    ("assistant", "Yes, replace the final loop with this:\n\n"
                  "```python\n"
                  "ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)\n"
                  "for destination, weight in ranked:\n"
                  "    print(f'{destination}: {weight:.1f} kg')\n"
                  "```\n\n"
                  "The heaviest destination is printed first."),
    ("user", "Perfect, that is exactly what I needed for the weekly report."),
]


def render(turns: list[tuple[str, str]]) -> str:
    """Same shape as `conversations.text` (wildchat.render / fixtures._render): `role: content` lines."""
    return "\n".join(f"{role}: {text.strip()}" for role, text in turns)


def transcript_problems(text: str, fixture_tokens: list[str] | None = None) -> list[str]:
    """Names of the deterministic privacy checks the transcript would trip (empty list = clean)."""
    from logless.pipeline.privacy import TokenScanner, contact_hits, source_id_hits
    out = contact_hits(text) + source_id_hits(text)
    if fixture_tokens and TokenScanner(fixture_tokens).hits(text):
        out.append("fixture_token")
    return out


# ---------------------------------------------------------------- read-only guards

def _open_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"database not found: {path.name} (is LOGLESS_DATA_DIR set?)")
    try:
        con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, check_same_thread=False)
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.OperationalError:  # e.g. a WAL database whose -shm file is absent
        con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA query_only = ON")
    con.row_factory = sqlite3.Row
    return con


def _refuse_write(*_a: Any, **_k: Any):
    raise RuntimeError("story_example is read-only: a database write was attempted")


def _no_cache_get(*_a: Any, **_k: Any) -> None:
    return None


def _no_cache_put(*_a: Any, **_k: Any) -> None:
    return None


@contextlib.contextmanager
def read_only() -> Iterator[None]:
    """Install read-only db handles for this thread, refuse db.write, bypass the provider cache.
    Everything is restored on exit."""
    from logless import db
    from logless.config import settings
    from logless.pipeline import util
    from logless.providers import glm, http, jev

    s = settings()
    old_cons = getattr(db._local, "cons", None)
    old_paths = getattr(db._local, "paths", None)
    cons = {"private": _open_ro(s.private_db), "public": _open_ro(s.public_db)}
    db._local.cons = dict(cons)
    db._local.paths = {"private": s.private_db, "public": s.public_db}
    patches = [(db, "write", _refuse_write),
               (http, "cache_get", _no_cache_get), (http, "cache_put", _no_cache_put),
               (util, "cache_get", _no_cache_get),
               (glm, "cache_get", _no_cache_get), (glm, "cache_put", _no_cache_put),
               (jev, "cache_get", _no_cache_get), (jev, "cache_put", _no_cache_put)]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, fn in patches:
        setattr(mod, name, fn)
    try:
        yield
    finally:
        for mod, name, fn in saved:
            setattr(mod, name, fn)
        for con in cons.values():
            con.close()
        db._local.cons = old_cons if old_cons is not None else {}
        db._local.paths = old_paths if old_paths is not None else {}


# ---------------------------------------------------------------- lookups (SELECT only)

def build_of_snapshot(snapshot_id: str) -> str | None:
    """intake.build_of_snapshot without its ensure_schema() fallback: the snapshot's own build, or (for an
    intake snapshot) the base build."""
    from logless import db
    con = db.private()
    row = con.execute("SELECT build_id FROM builds WHERE snapshot_id = ? ORDER BY build_id DESC LIMIT 1",
                      (snapshot_id,)).fetchone()
    if row:
        return row["build_id"]
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intake_batches'").fetchone() is None:
        return None
    row = con.execute("SELECT base_build_id FROM intake_batches WHERE ingested_snapshot_id = ?", (snapshot_id,)).fetchone()
    return row["base_build_id"] if row else None


def conv_leaf_map(build_id: str, st: dict) -> dict[str, str]:
    """conversation -> leaf id for the build, as stats.assignment_rows maps it (theme -> leaf)."""
    from logless import db
    from logless.pipeline.classify import OTHER
    from logless.pipeline.stats import clusters_for
    clusters = clusters_for(st)
    t2leaf = {t: c["id"] for c in clusters if c["level"] == 2 for t in c["theme_ids"]}
    rows = db.private().execute("SELECT conv_id, theme_id FROM assignments WHERE build_id = ?", (build_id,)).fetchall()
    return {r["conv_id"]: t2leaf.get(r["theme_id"]) or t2leaf.get(OTHER) or "cl_other" for r in rows}


def node_index(snap: dict, st: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    """Published leaf and category nodes by id (structure_final fills in anything the snapshot lacks)."""
    leaves: dict[str, dict] = {}
    for lf in st.get("leaves", []):
        leaves[lf["id"]] = {"id": lf["id"], "title": lf.get("title") or lf.get("name"), "short_title": lf.get("short_title"),
                            "parent_id": lf.get("parent_id")}
    cats: dict[str, dict] = {}
    for c in st.get("categories", []):
        cats[c["id"]] = {"id": c["id"], "title": c.get("title_pub") or c.get("title"), "short_title": c.get("short_title")}
    for n in snap.get("clusters", []):
        leaves[n["id"]] = {**leaves.get(n["id"], {}), **{k: n.get(k) for k in ("id", "title", "short_title", "parent_id",
                                                                                "conversations", "users")}}
    for n in snap.get("categories", []):
        cats[n["id"]] = {**cats.get(n["id"], {}), **{k: n.get(k) for k in ("id", "title", "short_title", "conversations",
                                                                            "users")}}
    return leaves, cats


# ---------------------------------------------------------------- stages (pure where possible)

def stage_facets(text: str, model: str) -> tuple[dict, Any, str]:
    """facets.extract_one without the INSERTs. Returns (record, final Facets, text that gets embedded)."""
    from logless.config import GLM, GLM_FLASH, JEV
    from logless.pipeline import facets as fac
    from logless.pipeline import util
    from logless.pipeline.prompts import FACET_REWRITE_SYS, FACET_SYS, Facets

    user = "<conversation>\n" + text + "\n</conversation>"
    t0 = time.perf_counter()
    try:
        f = util.glm_json(FACET_SYS, user, Facets, model=model, reasoning="off", temperature=0.2, max_tokens=600,
                          patience=0)
    except Exception as e:
        log.warning("facets: %s on %s, one fallback attempt with the other model", type(e).__name__, model)
        model = GLM if model == GLM_FLASH else GLM_FLASH
        f = util.glm_json(FACET_SYS, user, Facets, model=model, reasoning="off", temperature=0.2, max_tokens=600)
    glm_ms = _ms(t0)
    f = fac._clean(f)
    ft = fac.facet_text(f)
    t1 = time.perf_counter()
    p = fac._pii(ft)
    pii_ms = _ms(t1)
    p_after, status, rewrite = None, "ok", None
    if p >= fac.PII_THRESHOLD:
        t2 = time.perf_counter()
        g = util.glm_json(FACET_REWRITE_SYS, f.model_dump_json(), Facets, model=GLM_FLASH, reasoning="off",
                          temperature=0.2, max_tokens=500)
        g = fac._clean(Facets(user_goal=g.user_goal, task=g.task, domain=g.domain, language=f.language))
        ft2 = fac.facet_text(g)
        rewrite_ms = _ms(t2)
        t3 = time.perf_counter()
        p_after = fac._pii(ft2)
        rewrite = {"model": GLM_FLASH, "ms": rewrite_ms, "pii_ms": _ms(t3)}
        f, ft, status = g, ft2, "rewritten"
        if p_after >= fac.PII_THRESHOLD:
            status = "fallback"
            ft = fac.PRIVATE_FACET
    emb_text = fac.safe_embedding_text(ft)
    low = ft.lower()
    rec = {
        "model": model, "ms": _ms(t0), "glm_ms": glm_ms,
        "user_goal": f.user_goal, "task": f.task, "domain": f.domain, "language": f.language,
        "facet_text": ft,
        "pii": {"model": JEV, "threshold": fac.PII_THRESHOLD, "before": round(float(p), 4), "ms": pii_ms,
                "after": round(float(p_after), 4) if p_after is not None else None, "status": status,
                "rewrite": rewrite},
        "fake_name_in_facet_text": any(n.lower() in low for n in FAKE_NAME),
        "fake_company_in_facet_text": FAKE_COMPANY.lower() in low,
        "embedding_text_is_facet_text": emb_text == ft,
    }
    return rec, f, emb_text


def stage_embedding(emb_text: str) -> tuple[dict, np.ndarray]:
    """discover.embed_texts for one text, without its embedding_cache: straight to the provider."""
    from logless.config import EMBEDDING_MODEL
    from logless.providers import fireworks
    t0 = time.perf_counter()
    X = fireworks.embed([emb_text]).astype(np.float32)
    X = X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
    v = X[0]
    return {"model": EMBEDDING_MODEL, "ms": _ms(t0), "dims": int(v.shape[0]),
            "first_values": [round(float(x), 4) for x in v[:6]]}, v


def neighbour_summary(ids: list[str], X: np.ndarray, v: np.ndarray, conv_leaf: dict[str, str],
                      leaves: dict[str, dict], k: int = NEIGHBOURS_K) -> dict:
    """Cosine top-k over the build's saved embeddings; only aggregates leave this function."""
    if len(ids) != len(X) or not len(ids):
        raise SystemExit("build embeddings are empty or do not match their ids file")
    Xn = X.astype(np.float32) / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)
    sims = Xn @ v.astype(np.float32)
    k = min(k, len(ids))
    top = np.argpartition(-sims, k - 1)[:k]
    top = top[np.argsort(-sims[top], kind="stable")]
    counts = Counter(conv_leaf.get(ids[i], "unassigned") for i in top)
    by_leaf = []
    for leaf_id, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        meta = leaves.get(leaf_id, {})
        by_leaf.append({"leaf_id": leaf_id, "title": meta.get("title"), "short_title": meta.get("short_title"),
                        "count": int(n)})
    return {"k": int(k), "pool": len(ids), "top_similarity": round(float(sims[top[0]]), 4), "by_leaf": by_leaf}


def jev_decision(ans: dict, by_name: dict[str, str], leaves: dict[str, dict], top_n: int = 3) -> dict:
    """intake.run_batch's per-conversation decision (theme cutoff -> Other, friction tri-state)."""
    from logless.config import JEV_CONFIDENCE_CUTOFF
    from logless.intake import OTHER_LEAF
    from logless.pipeline.questions import OTHER_LABEL, SIGNALS
    from logless.providers import jev as jevmod

    choice, p = jevmod.top(ans["theme"])
    leaf = by_name.get(choice) if (choice != OTHER_LABEL and p >= JEV_CONFIDENCE_CUTOFF) else None
    leaf = leaf or OTHER_LEAF
    ranked = sorted(ans["theme"]["probabilities"].items(), key=lambda kv: (-float(kv[1]), kv[0]))[:top_n]
    top3 = [{"name": name, "leaf_id": OTHER_LEAF if name == OTHER_LABEL else by_name.get(name),
             "p": round(float(pr), 4)} for name, pr in ranked]
    friction = {}
    for s in SIGNALS:
        stored, raw, ps = jevmod.tri_state(ans[s], JEV_CONFIDENCE_CUTOFF)
        friction[s] = {"stored": stored, "raw_choice": raw, "p": round(float(ps), 4)}
    meta = leaves.get(leaf, {})
    return {"cutoff": JEV_CONFIDENCE_CUTOFF,
            "theme": {"top": top3, "raw_choice": choice, "p": round(float(p), 4), "below_cutoff": p < JEV_CONFIDENCE_CUTOFF,
                      "chosen_leaf_id": leaf, "chosen_title": meta.get("title")},
            "friction": friction}


def placement(leaf_id: str, leaves: dict[str, dict], cats: dict[str, dict]) -> dict:
    lf = leaves.get(leaf_id) or {"id": leaf_id}
    c = cats.get(lf.get("parent_id") or "", {})
    return {"leaf": {"id": leaf_id, "title": lf.get("title"), "short_title": lf.get("short_title"),
                     "conversations": lf.get("conversations"), "people": lf.get("users")},
            "category": {"id": c.get("id"), "title": c.get("title"), "short_title": c.get("short_title"),
                         "conversations": c.get("conversations"), "people": c.get("users")}}


def _ms(t0: float) -> int:
    return int(round(1000 * (time.perf_counter() - t0)))


# ---------------------------------------------------------------- main

def run(facet_model: str, k: int = NEIGHBOURS_K) -> dict:
    from logless import intake
    from logless.config import EMBEDDING_MODEL, JEV, settings
    from logless.data import fixtures
    from logless.pipeline import discover
    from logless.pipeline.questions import FRICTION_Q
    from logless.pipeline.run import load_build

    text = render(TRANSCRIPT)
    with read_only():
        tokens = fixtures.load_tokens()                         # SELECT tokens_json FROM eval_fixtures
        bad = transcript_problems(text, tokens)
        if bad:
            raise SystemExit(f"synthetic transcript trips privacy checks: {', '.join(bad)}")

        snap = intake.current_snapshot()                        # SELECT json FROM snapshots WHERE is_current = 1
        if snap is None:
            raise SystemExit("no current snapshot")
        snapshot_id = snap["snapshot_id"]
        build_id = build_of_snapshot(snapshot_id)               # SELECT builds / intake_batches
        if not build_id:
            raise SystemExit(f"no build found behind snapshot {snapshot_id}")
        build = load_build(build_id)                            # SELECT * FROM builds WHERE build_id = ?
        st = build.load("structure_final")
        leaves, cats = node_index(snap, st)

        d = settings().data_dir / "embeddings"
        if not (d / f"{build.build_id}.npy").exists() or not (d / f"{build.build_id}.ids.json").exists():
            raise SystemExit(f"saved embeddings for {build.build_id} are missing; refusing to rebuild them")
        emb_ids, X = discover.load_embeddings(build)            # reads the two files only
        conv_leaf = conv_leaf_map(build.build_id, st)           # SELECT conv_id, theme_id FROM assignments

        # a. facets + PII check
        facets_rec, f, emb_text = stage_facets(text, facet_model)
        # b. embedding
        emb_rec, v = stage_embedding(emb_text)
        # c. nearest neighbours in the build
        t0 = time.perf_counter()
        nb = neighbour_summary(emb_ids, X, v, conv_leaf, leaves, k)
        nb = {"model": EMBEDDING_MODEL, "ms": _ms(t0), **nb}
        # d. one Jev call: theme + friction, exactly as live intake asks it
        theme_q, by_name = intake._leaf_question(st)
        questions = {**FRICTION_Q, **theme_q}
        state = {"conversation": text,
                 "facets": {"user_goal": f.user_goal or "", "task": f.task or "", "domain": f.domain or ""}}
        t0 = time.perf_counter()
        ans = intake.ASK(state, questions)                      # jev.ask(..., use_cache=False)
        jev_ms = _ms(t0)
        dec = {"model": JEV, "ms": jev_ms, "questions": len(questions), **jev_decision(ans, by_name, leaves)}
        # e. placement in the published hierarchy
        t0 = time.perf_counter()
        place = {"model": None, "snapshot_id": snapshot_id, **placement(dec["theme"]["chosen_leaf_id"], leaves, cats)}
        place["ms"] = _ms(t0)

        out = {
            "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "snapshot_id": snapshot_id,
            "build_id": build.build_id,
            "synthetic": True,
            "note": NOTE,
            "transcript": [{"role": r, "text": t} for r, t in TRANSCRIPT],
            "stages": {"facets": facets_rec, "embedding": emb_rec, "neighbours": nb, "jev": dec, "placement": place},
        }
        blob = json.dumps(out, ensure_ascii=False)
        from logless.pipeline.privacy import TokenScanner
        if tokens and TokenScanner(tokens).hits(blob):
            raise SystemExit("output contains a fixture token; not writing it")
        model_text = " ".join(str(facets_rec[x]) for x in ("user_goal", "task", "domain", "facet_text"))
        if transcript_problems(model_text):
            log.warning("facet output trips a deterministic privacy pattern; review before publishing")
    return out


def main(argv: list[str] | None = None) -> int:
    from logless.config import GLM, GLM_FLASH  # constants only; settings() is not touched before parsing
    ap = argparse.ArgumentParser(description="Run one synthetic conversation through the real pipeline functions "
                                             "(read-only) and write a JSON story record.")
    ap.add_argument("--out", help="output path (default: stdout)")
    ap.add_argument("--facet-model", default=GLM_FLASH, choices=[GLM_FLASH, GLM],
                    help="facet model tried first; the other one is the fallback, as in extract_one (default: %(default)s)")
    ap.add_argument("--k", type=int, default=NEIGHBOURS_K, help="nearest neighbours to aggregate (default: %(default)s)")
    args = ap.parse_args(argv)
    if args.k < 1:
        ap.error("--k must be positive")
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    out = run(args.facet_model, args.k)
    doc = json.dumps(out, ensure_ascii=False, indent=1)
    if args.out:
        p = Path(args.out)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(doc + "\n")
        tmp.replace(p)
        print(f"wrote {p}", file=sys.stderr)
    else:
        print(doc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
