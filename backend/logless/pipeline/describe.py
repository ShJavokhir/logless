"""Stage 7 — describe: per leaf, GLM-5.3 writes title / description / needs / problems from 25
in-cluster facets (distinct people, friction-bearing ones oversampled) + 10 nearest-neighbour facets
+ the leaf's private friction counts. Evidence is validated in code: cited records must exist and be
in-cluster, and a problem mapped to a signal must cite records where that signal was observed.
`support = "common"` requires validated evidence from >= 5 distinct people. Categories get a title
and description from their leaves. Evidence (conversation ids per n/p id) stays private."""
from __future__ import annotations

import json
import logging
import random
import re
from collections import Counter, defaultdict

import numpy as np

from .. import db
from ..config import GLM, settings
from . import util
from .classify import OTHER, assignments
from .discover import load_embeddings, load_facets
from .hierarchy import load_structure
from .prompts import CATEGORY_TEXT_SYS, DESCRIBE_SYS, FRICTION_NOTE_SYS, CategoryTexts, Description, FrictionNote
from .questions import FRICTION_QV, SIGNALS

log = logging.getLogger("logless.pipeline.describe")

N_IN, N_FRICTION, N_NB = 25, 12, 10
COMMON_PEOPLE = 5
OTHER_LEAF_TITLE = "Other or unclear requests"
OTHER_LEAF_DESC = ("Conversations that did not clearly fit any theme: unintelligible or empty requests, one-off "
                   "topics, or requests that spanned several themes equally.")

_VERSIONED = r"(?:gpt|python|windows|ios|android|java|php|html|css|es|minecraft|unity|excel|office|vue|angular|react|node|django|bootstrap|laravel|diffusion|sd|web|mp|h|ipv|dall-e|dalle|midjourney|v|chatgpt|glm|qwen|llama|macos|ubuntu|debian|net|c|x|ps|xbox|fifa|iphone|galaxy|word|photoshop)"
NUMBER_RES = [
    re.compile(r"\d+(?:[.,]\d+)?\s*%"),
    re.compile(r"\b(?:percent|percentage|dozens|hundreds|thousands|millions|majority|minority|half of|a third of|a quarter of)\b", re.I),
    re.compile(r"\b(?:most|many|few|several|numerous|countless)\s+(?:people|users|conversations|requests|of them)\b", re.I),
    re.compile(r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)\s+(?:people|users|conversations|requests|times)\b", re.I),
]
STANDALONE_NUM = re.compile(r"(?<![\w.\-])(\d+(?:[.,]\d+)?)(?![\w\-])")


def has_number(text: str) -> bool:
    """True if the text states a number/quantity. Version numbers of well-known products are allowed
    (e.g. 'GPT-4', 'Python 3', 'Windows 10', '3D')."""
    if any(r.search(text) for r in NUMBER_RES):
        return True
    for m in STANDALONE_NUM.finditer(text):
        before = text[: m.start()].rstrip(" -").lower()
        if re.search(_VERSIONED + r"$", before):
            continue
        return True
    return False


def sentences(text: str) -> int:
    return len([s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s])


# ---------------------------------------------------------------- data

def load_friction(conv_ids: list[str]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = defaultdict(dict)
    con = db.private()
    for chunk in util.chunks(conv_ids, 900):
        q = "SELECT conv_id, signal, choice FROM friction WHERE question_version = ? AND conv_id IN ({})".format(",".join("?" * len(chunk)))
        for r in con.execute(q, [FRICTION_QV, *chunk]):
            out[r["conv_id"]][r["signal"]] = r["choice"]
    return out


def leaf_members(build: util.Build, leaves: list[dict]) -> dict[str, list[str]]:
    asg = assignments(build.build_id)
    t2l = {tid: lf["id"] for lf in leaves for tid in lf["theme_ids"]}
    out: dict[str, list[str]] = {lf["id"]: [] for lf in leaves}
    for c in build.conv_ids:
        out[t2l.get(asg.get(c, OTHER), "cl_other")].append(c)
    return out


def leaf_centroids(build: util.Build, members: dict[str, list[str]]) -> dict[str, np.ndarray]:
    ids, X = load_embeddings(build)
    pos = {c: i for i, c in enumerate(ids)}
    out = {}
    for lid, cs in members.items():
        idx = [pos[c] for c in cs if c in pos]
        if idx:
            v = X[idx].mean(axis=0)
            out[lid] = v / max(float(np.linalg.norm(v)), 1e-12)
    return out


def nearest_leaf(lid: str, cents: dict[str, np.ndarray], exclude_other: bool = True) -> str | None:
    best, bs = None, -2.0
    for k, v in cents.items():
        if k == lid or (exclude_other and k == "cl_other"):
            continue
        s = float(cents[lid] @ v)
        if s > bs:
            best, bs = k, s
    return best


def sample_records(members: list[str], facets: dict, fr: dict, seed: int) -> list[str]:
    """Up to N_IN conversations from distinct people; up to N_FRICTION of them friction-bearing."""
    rng = random.Random(seed)
    ms = sorted(members)
    rng.shuffle(ms)
    used_people: set[str] = set()
    chosen: list[str] = []
    fric = [c for c in ms if "observed" in fr.get(c, {}).values()]
    for c in fric:
        if len(chosen) >= N_FRICTION:
            break
        u = facets[c]["user_id"]
        if u not in used_people:
            used_people.add(u)
            chosen.append(c)
    for c in ms:
        if len(chosen) >= N_IN:
            break
        u = facets[c]["user_id"]
        if u not in used_people and c not in chosen:
            used_people.add(u)
            chosen.append(c)
    return chosen


def dominance(members: list[str], facets: dict) -> float:
    if not members:
        return 0.0
    return Counter(facets[c]["user_id"] for c in members).most_common(1)[0][1] / len(members)


# ---------------------------------------------------------------- describe one leaf

def validate(d: Description, recs: dict[str, str], fr: dict, facets: dict) -> tuple[list[str], dict]:
    """Return (errors, cleaned) — cleaned has needs/problems with validated evidence conv ids."""
    errs = []
    if util.words(d.title) > 8:
        errs.append("title has more than 8 words")
    if sentences(d.description) > 2:
        errs.append("description has more than two sentences")
    for label, t in [("title", d.title), ("description", d.description)] + \
            [(f"need {i + 1}", n.text) for i, n in enumerate(d.needs)] + \
            [(f"problem {i + 1}", p.text) for i, p in enumerate(d.problems)]:
        if has_number(t):
            errs.append(f"{label} states a number or quantity")
    needs = []
    for i, n in enumerate(d.needs):
        ev = [recs[r] for r in dict.fromkeys(n.evidence) if r in recs]
        if not ev:
            errs.append(f"need {i + 1} cites no valid in-cluster record")
            continue
        needs.append({"text": n.text.strip(), "evidence": ev})
    if len(needs) < 2:
        errs.append("fewer than two supported needs")
    problems = []
    for i, p in enumerate(d.problems):
        ev = [recs[r] for r in dict.fromkeys(p.evidence) if r in recs]
        if not ev:
            errs.append(f"problem {i + 1} cites no valid in-cluster record")
            continue
        if p.signal:
            ev_sig = [c for c in ev if fr.get(c, {}).get(p.signal) == "observed"]
            if not ev_sig:
                errs.append(f"problem {i + 1} is mapped to {p.signal} but none of its cited records shows that signal")
                continue
            ev = ev_sig
        problems.append({"text": p.text.strip(), "signal": p.signal, "evidence": ev})
    return errs, {"needs": needs[:4], "problems": problems[:4]}


def friction_note(conv_id: str, signals: list[str]) -> str | None:
    """Private, generalized note on what fell short in one friction-bearing conversation (describe evidence)."""
    row = db.private().execute("SELECT text FROM conversations WHERE conv_id = ?", (conv_id,)).fetchone()
    if row is None:
        return None
    try:
        n = util.glm_json(FRICTION_NOTE_SYS.format(signals=", ".join(signals)),
                          "<conversation>\n" + row["text"] + "\n</conversation>", FrictionNote, model=GLM,
                          reasoning="off", temperature=0.1, max_tokens=200)
        return util.clip_words(n.fell_short.strip(), 40)
    except Exception as e:
        log.warning("friction note failed (%s)", type(e).__name__)
        return None


def describe_leaf(leaf: dict, members: list[str], nb_members: list[str], facets: dict, fr: dict, seed: int) -> dict:
    chosen = sample_records(members, facets, fr, seed)
    recs = {f"r{i + 1}": c for i, c in enumerate(chosen)}
    rng = random.Random(seed + 1)
    nb_people: dict[str, str] = {}
    nbs = sorted(nb_members)
    rng.shuffle(nbs)
    for c in nbs:
        nb_people.setdefault(facets[c]["user_id"], c)
    nb = list(nb_people.values())[:N_NB]
    counts = {s: sum(1 for c in members if fr.get(c, {}).get(s) == "observed") for s in SIGNALS}
    lines = [f"Working name: {leaf['name']}", f"Working description: {leaf['description']}",
             f"Includes: {leaf['includes']}", f"Excludes: {leaf['excludes']}", "",
             "In-cluster records:"]
    notes: dict[str, str] = {}
    for r, c in recs.items():
        obs = [s for s in SIGNALS if fr.get(c, {}).get(s) == "observed"]
        rec = {"id": r, "facet": facets[c]["facet_text"], "friction_observed": obs}
        if obs:
            note = friction_note(c, obs)
            if note:
                rec["what_fell_short"] = note
                notes[c] = note
        lines.append(json.dumps(rec, ensure_ascii=False))
    lines += ["", "Contrast records from the nearest neighbouring cluster (do not cite):"]
    lines += [json.dumps({"id": f"x{i + 1}", "facet": facets[c]["facet_text"]}, ensure_ascii=False) for i, c in enumerate(nb)]
    lines += ["", "Private friction counts for the whole cluster (for your judgment only; never state numbers): " +
              json.dumps({"conversations": len(members), **{f"{s}_observed": n for s, n in counts.items()}})]
    user = "\n".join(lines)
    d = util.glm_json(DESCRIBE_SYS, user, Description, model=GLM, reasoning="low", temperature=0.3, max_tokens=5000)
    errs, clean = validate(d, recs, fr, facets)
    attempts = 1
    if errs:
        fix = user + "\n\nYour previous answer was:\n" + d.model_dump_json() + "\n\nIt had these problems: " + "; ".join(errs) + \
              ". Return a corrected answer. Drop any problem you cannot support with the right records."
        try:
            d2 = util.glm_json(DESCRIBE_SYS, fix, Description, model=GLM, reasoning="low", temperature=0.2, max_tokens=5000)
            errs2, clean2 = validate(d2, recs, fr, facets)
            attempts = 2
            if len(errs2) <= len(errs):
                d, errs, clean = d2, errs2, clean2
        except Exception as e:
            log.warning("describe repair failed (%s)", type(e).__name__)
    title = util.clip_words(d.title.strip().rstrip("."), 8)
    desc = d.description.strip()
    if sentences(desc) > 2:
        desc = " ".join(re.split(r"(?<=[.!?])\s+", desc)[:2])
    needs, problems, evidence = [], [], {}
    for i, n in enumerate(clean["needs"]):
        nid = f"n{i + 1}"
        needs.append({"id": nid, "text": n["text"]})
        evidence[nid] = n["evidence"]
    for i, p in enumerate(clean["problems"]):
        pid = f"p{i + 1}"
        people = {facets[c]["user_id"] for c in p["evidence"]}
        problems.append({"id": pid, "text": p["text"], "signal": p["signal"],
                         "support": "common" if len(people) >= COMMON_PEOPLE else "observed"})
        evidence[pid] = p["evidence"]
    return {"title": title, "description": desc, "needs": needs, "problems": problems, "evidence": evidence,
            "residual_errors": errs, "attempts": attempts, "records": list(recs.values()), "neighbour_records": nb,
            "friction_counts": counts, "notes": notes}


def support_label(evidence: list[str], facets: dict) -> str:
    return "common" if len({facets[c]["user_id"] for c in evidence}) >= COMMON_PEOPLE else "observed"


# ---------------------------------------------------------------- stage

def run(build: util.Build) -> dict:
    st = build.load("structure")
    leaves, cats = st["leaves"], st["categories"]
    members = leaf_members(build, leaves)
    facets = load_facets(build.conv_ids)
    fr = load_friction(build.conv_ids)
    cents = leaf_centroids(build, members)
    jobs = []
    for i, lf in enumerate(leaves):
        if lf["is_other"]:
            continue
        nb = nearest_leaf(lf["id"], cents) if lf["id"] in cents else None
        jobs.append((lf, nb))

    def one(job):
        lf, nb = job
        return describe_leaf(lf, members[lf["id"]], members.get(nb, []) if nb else [], facets, fr,
                             seed=int(lf["id"][3:], 16) if lf["id"] != "cl_other" else 0)

    out, errs = util.pmap(one, jobs, settings().glm_concurrency, "describe")
    evidence: dict[str, dict] = {}
    private: dict[str, dict] = {}
    residual = 0
    for (lf, nb), d in zip(jobs, out):
        if d is None:  # describe failed: fall back to the working name, which the gate still checks
            d = {"title": util.clip_words(lf["name"], 8), "description": lf["description"], "needs": [], "problems": [],
                 "evidence": {}, "residual_errors": ["describe failed"], "attempts": 0, "records": [],
                 "neighbour_records": [], "friction_counts": {}, "notes": {}}
        lf.update({"title": d["title"], "description_pub": d["description"], "needs": d["needs"], "problems": d["problems"]})
        evidence[lf["id"]] = d["evidence"]
        private[lf["id"]] = {k: d[k] for k in ("records", "neighbour_records", "friction_counts", "residual_errors", "attempts", "notes")}
        private[lf["id"]]["neighbour"] = nb
        private[lf["id"]]["dominance"] = round(dominance(members[lf["id"]], facets), 4)
        residual += bool(d["residual_errors"])
    for lf in leaves:
        if lf["is_other"]:
            lf.update({"title": OTHER_LEAF_TITLE, "description_pub": OTHER_LEAF_DESC, "needs": [], "problems": []})
            private[lf["id"]] = {"dominance": round(dominance(members[lf["id"]], facets), 4)}
    # categories: title + description from their leaves
    ncat = [c for c in cats if not c.get("is_other")]
    lines = []
    for c in ncat:
        ls = [{"title": lf["title"], "description": lf["description_pub"]} for lf in leaves if lf["parent_id"] == c["id"]]
        lines.append(json.dumps({"id": c["id"], "working_title": c["title"], "leaves": ls}, ensure_ascii=False))
    try:
        ct = util.glm_json(CATEGORY_TEXT_SYS, "\n".join(lines), CategoryTexts, model=GLM, reasoning="low",
                           temperature=0.2, max_tokens=4000)
        by_id = {x.id: x for x in ct.categories}
        for c in ncat:
            x = by_id.get(c["id"])
            if x and not has_number(x.title + " " + x.description):
                c["title_pub"] = util.clip_words(x.title.strip().rstrip("."), 8)
                c["description_pub"] = x.description.strip()
    except Exception as e:
        log.warning("category text failed (%s)", type(e).__name__)
    for c in cats:
        c.setdefault("title_pub", c["title"])
        c.setdefault("description_pub", c["description"])
    dominated = [lid for lid, p in private.items() if p.get("dominance", 0) > 0.5]
    build.save("structure_described", {**st, "leaves": leaves, "categories": cats})
    build.save("evidence", evidence)  # private: conversation ids per need/problem
    build.save("describe_private", {"leaves": private, "dominated": dominated})
    n_common = sum(1 for lf in leaves for p in lf.get("problems", []) if p["support"] == "common")
    return {"leaves_described": len(jobs), "errors": errs, "residual_validation": residual,
            "needs": sum(len(lf.get("needs", [])) for lf in leaves),
            "problems": sum(len(lf.get("problems", [])) for lf in leaves), "problems_common": n_common,
            "dominated_clusters": len(dominated)}
