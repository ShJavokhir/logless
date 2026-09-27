"""Stage 3 — classify every conversation: one Jev Choice over all themes + "Other or unclear".
State = {conversation, facets}; top probability < 0.65 → Other. Real volumes are preserved:
every conversation (including a templated heavy user's) is counted."""
from __future__ import annotations

import logging
from collections import Counter

from .. import db
from ..config import JEV_CONFIDENCE_CUTOFF, settings
from ..providers import jev
from . import util
from .discover import active_themes
from .questions import OTHER_LABEL, theme_question

log = logging.getLogger("logless.pipeline.classify")
OTHER = "other"


def classify(build: util.Build, conv_ids: list[str], themes: list[dict], rnd: int) -> dict:
    q = theme_question(themes)
    by_name = {t["name"]: t["theme_id"] for t in themes}
    rows = util.load_rows(conv_ids, "SELECT c.conv_id, c.text, f.user_goal, f.task, f.domain FROM conversations c "
                                    "LEFT JOIN facets f USING(conv_id) WHERE c.conv_id IN ({})")

    def one(c: str) -> tuple[str, str, float]:
        r = rows[c]
        state = {"conversation": r["text"],
                 "facets": {"user_goal": r["user_goal"] or "", "task": r["task"] or "", "domain": r["domain"] or ""}}
        ans = util.jev_ask(state, q)["theme"]
        choice, p = jev.top(ans)
        if choice == OTHER_LABEL or p < JEV_CONFIDENCE_CUTOFF or choice not in by_name:
            return c, OTHER, p
        return c, by_name[choice], p

    out, errs = util.pmap(one, conv_ids, settings().jev_concurrency, f"classify-r{rnd}")
    recs = [(build.build_id, r[0], r[1], r[2], rnd) if r else (build.build_id, c, OTHER, 0.0, rnd)
            for c, r in zip(conv_ids, out)]
    con = db.private()
    with db.write(con):
        con.executemany("INSERT OR REPLACE INTO assignments(build_id, conv_id, theme_id, p, round) VALUES (?,?,?,?,?)", recs)
    cnt = Counter(r[2] for r in recs)
    low = sum(1 for r in out if r and r[1] == OTHER and r[2] < JEV_CONFIDENCE_CUTOFF)
    return {"classified": len(recs), "other": cnt.get(OTHER, 0), "low_confidence": low, "errors": errs,
            "themes_used": sum(1 for k in cnt if k != OTHER)}


def assignments(build_id: str) -> dict[str, str]:
    return {r["conv_id"]: r["theme_id"] for r in
            db.private().execute("SELECT conv_id, theme_id FROM assignments WHERE build_id = ?", (build_id,))}


def run(build: util.Build) -> dict:
    themes = active_themes(build.build_id)
    counts = classify(build, build.conv_ids, themes, 1)
    counts["themes"] = len(themes)
    return counts
