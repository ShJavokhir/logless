"""Stage 4 — leftovers: while "Other or unclear" holds more than 8% of conversations, re-discover on
the leftovers only (same capping), name, add themes (or broaden an existing one), and classify the
leftovers again over all themes. At most 3 discovery rounds in total; never more than 34 themes
(the contract allows 15–35 leaves including cl_other)."""
from __future__ import annotations

import json
import logging

from .. import db
from ..config import GLM
from . import util
from .classify import OTHER, assignments, classify
from .discover import active_themes, discover_round, save_themes
from .prompts import LEFTOVER_SYS, LeftoverConsolidation

log = logging.getLogger("logless.pipeline.leftovers")

OTHER_MAX_SHARE = 0.08
MAX_ROUNDS = 3
MAX_THEMES = 34


def _consolidate_leftovers(existing: list[dict], named: list[dict]) -> list[dict]:
    ex = [json.dumps({"name": t["name"], "description": t["description"]}, ensure_ascii=False) for t in existing]
    cand = [json.dumps({"id": c["id"], "name": c["name"], "description": c["description"], "includes": c["includes"],
                        "excludes": c["excludes"], "share_of_people": f"{100 * c['people_share']:.1f}%"},
                       ensure_ascii=False) for c in named]
    user = "EXISTING themes:\n" + "\n".join(ex) + "\n\nNEW candidate clusters:\n" + "\n".join(cand)
    out = util.glm_json(LEFTOVER_SYS, user, LeftoverConsolidation, model=GLM, reasoning="low", temperature=0.2,
                        max_tokens=8000)
    return [t.model_dump() for t in out.themes]


def run(build: util.Build) -> dict:
    rounds = 1
    added = broadened = 0
    history = []
    for rnd in range(2, MAX_ROUNDS + 1):
        asg = assignments(build.build_id)
        other = [c for c in build.conv_ids if asg.get(c, OTHER) == OTHER]
        share = len(other) / max(1, len(build.conv_ids))
        existing = active_themes(build.build_id)
        room = MAX_THEMES - len(existing)
        history.append({"round": rnd, "other_before": len(other), "share_before": round(share, 4), "room": room})
        if share <= OTHER_MAX_SHARE or room <= 0 or len(other) < 12:
            break
        k = max(3, min(15, round(len(other) / 40)))
        rec = discover_round(build, other, rnd, k=k)
        props = _consolidate_leftovers(existing, rec["clusters"])
        by_name = {t["name"].lower(): t for t in existing}
        valid_ids = {c["id"] for c in rec["clusters"]}
        share_of = {c["id"]: c["people_share"] for c in rec["clusters"]}
        new, updates = [], []
        for p in props:
            cl = [c for c in p.get("clusters", []) if c in valid_ids]
            if not cl:
                continue
            same = (p.get("same_as") or "").strip().lower()
            if same and same in by_name:
                t = by_name[same]
                extra = (p.get("includes") or "").strip()
                if extra and extra.lower() not in (t["includes"] or "").lower():
                    t["includes"] = ((t["includes"] or "") + "; " + extra).strip("; ")
                    updates.append(t)
            else:
                if p["name"].lower() in by_name:
                    p["name"] = f"{p['name']} (additional)"
                p["people_share"] = sum(share_of[c] for c in cl)
                p["clusters"] = cl
                new.append(p)
        new.sort(key=lambda t: -t["people_share"])
        new = new[:room]
        con = db.private()
        with db.write(con):
            for t in updates:
                con.execute("UPDATE themes SET includes = ? WHERE build_id = ? AND theme_id = ?",
                            (t["includes"], build.build_id, t["theme_id"]))
        save_themes(build, new, rnd)
        added += len(new)
        broadened += len(updates)
        rec["proposals"] = props
        rec["new_themes"] = new
        build.save(f"discover_r{rnd}", rec)
        themes = active_themes(build.build_id)
        c = classify(build, other, themes, rnd)
        history[-1].update({"new_themes": len(new), "broadened": len(updates), "other_after": c["other"]})
        rounds = rnd
        log.info("leftovers round %d: +%d themes, %d broadened, other %d -> %d", rnd, len(new), len(updates),
                 len(other), c["other"])
    asg = assignments(build.build_id)
    other_n = sum(1 for c in build.conv_ids if asg.get(c, OTHER) == OTHER)
    build.info["discovery_rounds"] = rounds
    build.save("leftovers", {"history": history, "rounds": rounds})
    return {"rounds": rounds, "themes_added": added, "themes_broadened": broadened,
            "themes": len(active_themes(build.build_id)), "other": other_n}
