"""Stage 6 — hierarchy: GLM-5.3 groups leaf themes into categories; Jev re-files every leaf (Choice
over categories, state = the leaf); disagreements go back to GLM once. Exactly one parent per leaf.
The catch-all leaf `cl_other` sits in its own, clearly labelled "Other or unclear" category.

Public ids are assigned here: leaves `cl_` + 6 hex, categories `cat_` + 6 hex (stable within a
build/snapshot), and the catch-all leaf is `cl_other`."""
from __future__ import annotations

import json
import logging
from collections import Counter

from .. import db
from ..config import GLM, JEV_CONFIDENCE_CUTOFF, settings
from ..ids import short_hex
from ..providers import jev
from . import util
from .classify import OTHER, assignments
from .discover import active_themes
from .prompts import HIERARCHY_SYS, RESOLVE_SYS, Hierarchy, Resolution
from .questions import category_question

log = logging.getLogger("logless.pipeline.hierarchy")

CAT_MIN, CAT_MAX = 4, 7   # + the Other category → at most 8
OTHER_CAT_TITLE = "Other or unclear"
OTHER_CAT_DESC = "Requests that did not clearly fit any theme, were unintelligible, or spanned several themes equally."


def _public_id(prefix: str, seed: str, used: set[str]) -> str:
    n = 0
    while True:
        pid = prefix + short_hex(seed + (f"#{n}" if n else ""), 6)
        if pid not in used:
            used.add(pid)
            return pid
        n += 1


def run(build: util.Build) -> dict:
    themes = active_themes(build.build_id)
    asg = assignments(build.build_id)
    sizes = Counter(asg.values())
    total = max(1, len(asg))
    used: set[str] = set()
    tid_to_key = {t["theme_id"]: f"L{i + 1}" for i, t in enumerate(themes)}
    key_to_tid = {v: k for k, v in tid_to_key.items()}
    lines = [json.dumps({"id": tid_to_key[t["theme_id"]], "name": t["name"], "description": t["description"],
                         "share": f"{100 * sizes.get(t['theme_id'], 0) / total:.1f}%"}, ensure_ascii=False) for t in themes]
    sys = HIERARCHY_SYS.format(lo=min(CAT_MIN, len(themes)), hi=min(CAT_MAX, len(themes)))
    h = util.glm_json(sys, "Leaf themes (one JSON per line):\n" + "\n".join(lines), Hierarchy, model=GLM,
                      reasoning="low", temperature=0.2, max_tokens=6000)
    cats = [c.model_dump() for c in h.categories if c.title.strip()]
    # dedupe titles, assign GLM placements (first wins)
    seen_titles: set[str] = set()
    glm_place: dict[str, int] = {}
    clean = []
    for c in cats:
        t = util.clip_words(c["title"].strip(), 8)
        if t.lower() in seen_titles or t.lower() == OTHER_CAT_TITLE.lower():
            continue
        seen_titles.add(t.lower())
        idx = len(clean)
        clean.append({"title": t, "description": c["description"].strip()})
        for k in c["themes"]:
            if k in key_to_tid and key_to_tid[k] not in glm_place:
                glm_place[key_to_tid[k]] = idx
    cats = clean
    if not cats:
        raise RuntimeError("hierarchy: no categories returned")

    # Jev re-files every leaf
    q = category_question(cats)
    title_idx = {c["title"]: i for i, c in enumerate(cats)}

    def refile(t: dict) -> tuple[str, int | None, float]:
        ans = util.jev_ask({"theme": {"name": t["name"], "description": t["description"], "includes": t["includes"]}}, q)
        choice, p = jev.top(ans["category"])
        return t["theme_id"], title_idx.get(choice), p

    res, _ = util.pmap(refile, themes, settings().jev_concurrency, "refile")
    jev_place = {r[0]: (r[1], r[2]) for r in res if r}
    disagreements = []
    for t in themes:
        g = glm_place.get(t["theme_id"])
        j, p = jev_place.get(t["theme_id"], (None, 0.0))
        if g is None or (j is not None and j != g and p >= JEV_CONFIDENCE_CUTOFF):
            disagreements.append(t)
    final = dict(glm_place)
    resolved_changed = 0
    if disagreements:
        dl = []
        for t in disagreements:
            g = glm_place.get(t["theme_id"])
            j = jev_place.get(t["theme_id"], (None, 0))[0]
            dl.append(json.dumps({"theme": t["name"], "description": t["description"],
                                  "original": cats[g]["title"] if g is not None else None,
                                  "second_opinion": cats[j]["title"] if j is not None else None}, ensure_ascii=False))
        cl = "\n".join(json.dumps(c, ensure_ascii=False) for c in cats)
        try:
            r = util.glm_json(RESOLVE_SYS, f"Categories:\n{cl}\n\nThemes to place:\n" + "\n".join(dl), Resolution,
                              model=GLM, reasoning="low", temperature=0.1, max_tokens=4000)
            by_name = {t["name"]: t["theme_id"] for t in disagreements}
            for pl in r.placements:
                tid = by_name.get(pl.theme)
                if tid and pl.category in title_idx:
                    if final.get(tid) != title_idx[pl.category]:
                        resolved_changed += 1
                    final[tid] = title_idx[pl.category]
        except Exception as e:  # keep GLM's original placement, fall back to Jev when GLM had none
            log.warning("hierarchy: resolve failed (%s)", type(e).__name__)
    for t in themes:  # exactly one parent: GLM's placement, else Jev's, else the first category
        if t["theme_id"] not in final:
            final[t["theme_id"]] = jev_place.get(t["theme_id"], (0, 0))[0] or 0
    # drop empty categories
    used_idx = sorted(set(final.values()))
    remap = {old: new for new, old in enumerate(used_idx)}
    cats = [cats[i] for i in used_idx]
    final = {tid: remap[i] for tid, i in final.items()}

    # public ids
    for c in cats:
        c["id"] = _public_id("cat_", build.build_id + ":cat:" + c["title"], used)
    other_cat = {"id": _public_id("cat_", build.build_id + ":cat:other", used), "title": OTHER_CAT_TITLE,
                 "description": OTHER_CAT_DESC, "is_other": True}
    leaves = []
    for t in themes:
        leaves.append({"id": _public_id("cl_", build.build_id + ":leaf:" + t["theme_id"], used),
                       "theme_ids": [t["theme_id"]], "parent_id": cats[final[t["theme_id"]]]["id"],
                       "name": t["name"], "description": t["description"], "includes": t["includes"],
                       "excludes": t["excludes"], "is_other": False})
    leaves.append({"id": "cl_other", "theme_ids": [OTHER], "parent_id": other_cat["id"], "name": OTHER_CAT_TITLE,
                   "description": OTHER_CAT_DESC, "includes": "", "excludes": "", "is_other": True})
    cats.append(other_cat)
    con = db.private()
    with db.write(con):
        for lf in leaves:
            for tid in lf["theme_ids"]:
                con.execute("UPDATE themes SET category_id = ? WHERE build_id = ? AND theme_id = ?",
                            (lf["parent_id"], build.build_id, tid))
    structure = {"categories": cats, "leaves": leaves,
                 "refile": {"disagreements": len(disagreements), "changed_after_resolve": resolved_changed}}
    build.save("structure", structure)
    return {"categories": len(cats), "leaves": len(leaves), "jev_disagreements": len(disagreements),
            "changed_after_resolve": resolved_changed}


def load_structure(build: util.Build) -> dict:
    """The latest structure: after the gate (roll-ups) if present, else after hierarchy/describe."""
    for name in ("structure_final", "structure_described", "structure"):
        if build.has(name):
            return build.load(name)
    raise FileNotFoundError("structure missing; run the hierarchy stage")
