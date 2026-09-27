"""Stage 1 — facets (GLM-5.3-flash) + PII check (Jev noul) and friction (Jev tri-state).

Per-conversation results are shared across builds and resumable: rows already produced with the
current prompt/question version are skipped."""
from __future__ import annotations

import logging
import threading

from .. import db
from ..config import GLM, GLM_FLASH, JEV, JEV_CONFIDENCE_CUTOFF, settings
from ..ids import utcnow
from ..providers import jev
from . import util
from .prompts import FACET_REWRITE_SYS, FACET_SYS, PROMPT_VERSIONS, Facets
from .questions import FRICTION_Q, FRICTION_QV, PII_Q, PII_QV, SIGNALS

log = logging.getLogger("logless.pipeline.facets")

FACETS_V = PROMPT_VERSIONS["facets"] + "+" + PII_QV
PII_THRESHOLD = 0.5
FAILED_FACET = "Unreadable or empty request. Goal: unknown."

EXTRA_SCHEMA = """
CREATE TABLE IF NOT EXISTS facet_checks (
  conv_id TEXT PRIMARY KEY,
  pii_p REAL, pii_p_after REAL, rewritten INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- ok | rewritten | fallback | failed
  model TEXT, version TEXT, created_at TEXT
);
"""


def ensure_schema() -> None:
    db.private().executescript(EXTRA_SCHEMA)


def facet_text(f: Facets) -> str:
    task = f.task.strip().rstrip(".")
    goal = f.user_goal.strip().rstrip(".")
    return f"{task}. Goal: {goal}."


def _clean(f: Facets) -> Facets:
    return Facets(user_goal=util.clip_words(f.user_goal.strip(), 60), task=util.clip_words(f.task.strip(), 60),
                  domain=util.clip_words(f.domain.strip(), 8), language=util.clip_words(f.language.strip(), 4))


def _pii(text: str) -> float:
    ans = util.jev_ask({"facet": text}, PII_Q)
    return float(ans["identifying"]["noul"])


def primary_model(conv_id: str) -> str:
    """GLM-5.3-flash is the facet model; its per-model rate limit on Vultr Inference caps throughput at
    ~2.5 conversations/s, so a deterministic share of conversations overflows to GLM-5.3 (same prompt,
    same schema; the model is recorded per row and in provenance)."""
    return GLM if int(conv_id[2:], 16) % 100 < OVERFLOW_PCT else GLM_FLASH


OVERFLOW_PCT = 50


def extract_one(conv_id: str, text: str) -> tuple:
    user = "<conversation>\n" + text + "\n</conversation>"
    model = primary_model(conv_id)
    try:
        f = util.glm_json(FACET_SYS, user, Facets, model=model, reasoning="off", temperature=0.2, max_tokens=600,
                          patience=0)
    except Exception:
        model = GLM if model == GLM_FLASH else GLM_FLASH  # one fallback attempt with the other model
        f = util.glm_json(FACET_SYS, user, Facets, model=model, reasoning="off", temperature=0.2, max_tokens=600)
    f = _clean(f)
    ft = facet_text(f)
    p = _pii(ft)
    p_after, status = None, "ok"
    if p >= PII_THRESHOLD:
        g = util.glm_json(FACET_REWRITE_SYS, f.model_dump_json(), Facets, model=GLM_FLASH, reasoning="off",
                          temperature=0.2, max_tokens=500)
        g = _clean(Facets(user_goal=g.user_goal, task=g.task, domain=g.domain, language=f.language))
        ft2 = facet_text(g)
        p_after = _pii(ft2)
        f, ft, status = g, ft2, "rewritten"
        if p_after >= PII_THRESHOLD:
            # keep only the generic domain + goal shape; the facet text never leaves the backend,
            # but embeddings (Fireworks) must see generalized text only
            status = "fallback"
            ft = f"Help with a request about {g.domain}. Goal: {g.domain}."
    now = utcnow()
    con = db.private()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO facets(conv_id, user_goal, task, domain, language, facet_text, model, prompt_version, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)", (conv_id, f.user_goal, f.task, f.domain, f.language, ft, model, FACETS_V, now))
        con.execute("INSERT OR REPLACE INTO facet_checks(conv_id, pii_p, pii_p_after, rewritten, status, model, version, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)", (conv_id, p, p_after, int(status != "ok"), status, JEV, PII_QV, now))
    return status, model


def friction_one(conv_id: str, text: str) -> dict:
    ans = util.jev_ask({"conversation": text}, FRICTION_Q)
    now = utcnow()
    rows = []
    out = {}
    for s in SIGNALS:
        stored, raw, p = jev.tri_state(ans[s], JEV_CONFIDENCE_CUTOFF)
        rows.append((conv_id, s, stored, raw, p, JEV, FRICTION_QV, now))
        out[s] = stored
    con = db.private()
    with db.write(con):
        con.executemany("INSERT OR REPLACE INTO friction(conv_id, signal, choice, raw_choice, p, model, question_version, created_at)"
                        " VALUES (?,?,?,?,?,?,?,?)", rows)
    return out


def _mark_failed(conv_id: str) -> None:
    con = db.private()
    now = utcnow()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO facets(conv_id, user_goal, task, domain, language, facet_text, model, prompt_version, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)", (conv_id, "unknown", "unknown", "unknown", "unknown", FAILED_FACET, None, FACETS_V, now))
        con.execute("INSERT OR REPLACE INTO facet_checks(conv_id, pii_p, pii_p_after, rewritten, status, model, version, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)", (conv_id, None, None, 0, "failed", None, PII_QV, now))


def run(build: util.Build) -> dict:
    ensure_schema()
    s = settings()
    ids = build.conv_ids
    con = db.private()
    done_f = util.load_rows(ids, "SELECT conv_id FROM facets WHERE prompt_version = '" + FACETS_V + "' AND conv_id IN ({})")
    done_x = {}
    for chunk in util.chunks(ids, 900):
        q = ("SELECT conv_id, COUNT(*) n FROM friction WHERE question_version = ? AND conv_id IN ({}) GROUP BY conv_id"
             .format(",".join("?" * len(chunk))))
        for row in con.execute(q, [FRICTION_QV, *chunk]):
            if row["n"] == len(SIGNALS):
                done_x[row["conv_id"]] = True
    if util.no_cache():  # fresh run: recompute every conversation's facets and friction
        done_f, done_x = {}, {}
    need_f = [c for c in ids if c not in done_f]
    need_x = [c for c in ids if c not in done_x]
    texts = util.load_rows(sorted(set(need_f) | set(need_x)), "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})")
    log.info("facets: %d to extract (%d done), friction: %d to decide (%d done)", len(need_f), len(done_f), len(need_x), len(done_x))

    res: dict = {}

    def do_facets() -> None:
        out, errs = util.pmap(lambda c: extract_one(c, texts[c]["text"]), need_f, s.glm_concurrency, "facets")
        failed = [c for c, r in zip(need_f, out) if r is None]
        for c in failed:
            _mark_failed(c)
        res["facets"] = out
        res["facet_errors"] = errs

    def do_friction() -> None:
        out, errs = util.pmap(lambda c: friction_one(c, texts[c]["text"]), need_x, s.jev_concurrency, "friction")
        res["friction_errors"] = errs

    failed: list[BaseException] = []

    def guard(fn):
        def inner():
            try:
                fn()
            except BaseException as e:  # surfaced after join (e.g. ProviderUnavailable on billing errors)
                failed.append(e)
        return inner

    threads = [threading.Thread(target=guard(do_facets)), threading.Thread(target=guard(do_friction))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if failed:
        raise failed[0]

    # retry friction failures once, sequentially-ish
    still = []
    for chunk in util.chunks(ids, 900):
        q = ("SELECT conv_id, COUNT(*) n FROM friction WHERE question_version = ? AND conv_id IN ({}) GROUP BY conv_id"
             .format(",".join("?" * len(chunk))))
        have = {r["conv_id"] for r in con.execute(q, [FRICTION_QV, *chunk]) if r["n"] == len(SIGNALS)}
        still.extend(c for c in chunk if c not in have)
    if still:
        texts2 = util.load_rows(still, "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})")
        util.pmap(lambda c: friction_one(c, texts2[c]["text"]), still, 4, "friction-retry")

    counts = _counts(ids)
    counts["facet_errors"] = int(res.get("facet_errors", 0))
    counts["friction_errors"] = int(res.get("friction_errors", 0))
    return counts


def _counts(ids: list[str]) -> dict:
    checks = util.load_rows(ids, "SELECT conv_id, status FROM facet_checks WHERE conv_id IN ({})")
    fr = {}
    con = db.private()
    for chunk in util.chunks(ids, 900):
        q = "SELECT conv_id, signal, choice FROM friction WHERE question_version = ? AND conv_id IN ({})".format(",".join("?" * len(chunk)))
        for r in con.execute(q, [FRICTION_QV, *chunk]):
            fr.setdefault(r["conv_id"], {})[r["signal"]] = r["choice"]
    c = {"conversations": len(ids), "facets": len(checks),
         "pii_rewritten": sum(1 for r in checks.values() if r["status"] in ("rewritten", "fallback")),
         "pii_fallback": sum(1 for r in checks.values() if r["status"] == "fallback"),
         "facets_failed": sum(1 for r in checks.values() if r["status"] == "failed"),
         "friction_decided": len(fr),
         "friction_observed": sum(1 for d in fr.values() if "observed" in d.values())}
    for s in SIGNALS:
        c[f"{s}_observed"] = sum(1 for d in fr.values() if d.get(s) == "observed")
        c[f"{s}_unclear"] = sum(1 for d in fr.values() if d.get(s) == "unclear")
    return c
