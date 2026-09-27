"""Stage 8 — privacy gate on ALL published text (leaf titles, descriptions, needs, problems; category
titles and descriptions; fixed workspace text).

Checks per text: (a) canary + injection tokens, (b) contact / secret / URL / handle / user-path
patterns, (c) source-id patterns, (d) distinctive-phrase overlap (a 6+ word n-gram that occurs
verbatim in the raw text of 1..3 conversations), plus a no-numbers rule; (e) a GLM-5.3 audit pass
(identifying combinations, unsupported specifics, translated paraphrases) that rewrites; (f) Jev
identifiability Score 0–3 (>= 2 → rewrite). A text still failing after 2 rewrites is replaced with a
more general wording (needs/problems) or its leaf is rolled up into the nearest sibling leaf
(titles/descriptions). Clusters dominated by one person (> 50% of conversations) get a strict audit.
Outcomes are recorded as counts in the build record; per-text detail stays in private artifacts."""
from __future__ import annotations

import json
import logging
from collections import Counter

import numpy as np

from .. import db
from ..config import GLM, settings
from ..config_workspace import INTENDED_USES, WORKSPACE_DESCRIPTION, WORKSPACE_NAME
from ..data import fixtures
from . import util
from .describe import has_number, leaf_centroids, leaf_members, sentences
from .discover import load_facets
from .privacy import TokenScanner, contact_hits, distinctive_ngrams, source_id_hits
from .prompts import AUDIT_STRICT, AUDIT_SYS, REWRITE_SYS, Audit, Rewrites
from .questions import ident_questions

log = logging.getLogger("logless.pipeline.gate")

MAX_REWRITES = 2
IDENT_MAX = 2.0
GENERIC_PROBLEM = {
    "correction": "Answers sometimes had to be corrected before they were usable",
    "repeat_request": "People sometimes had to ask again to get what they wanted",
    "assistant_limit": "The assistant sometimes declined or could not complete the request",
    "complaint": "Some people expressed frustration with the assistant's answers",
    None: None,
}
LIMITS = {"title": 8, "cat_title": 8}


def _items(st: dict) -> list[dict]:
    items = []
    for lf in st["leaves"]:
        if lf["is_other"]:
            items.append({"key": f"{lf['id']}|title", "node": lf["id"], "role": "static", "text": lf["title"]})
            items.append({"key": f"{lf['id']}|description", "node": lf["id"], "role": "static", "text": lf["description_pub"]})
            continue
        items.append({"key": f"{lf['id']}|title", "node": lf["id"], "role": "title", "text": lf["title"]})
        items.append({"key": f"{lf['id']}|description", "node": lf["id"], "role": "description", "text": lf["description_pub"]})
        for n in lf["needs"]:
            items.append({"key": f"{lf['id']}|{n['id']}", "node": lf["id"], "role": "need", "text": n["text"]})
        for p in lf["problems"]:
            items.append({"key": f"{lf['id']}|{p['id']}", "node": lf["id"], "role": "problem", "text": p["text"],
                          "signal": p["signal"]})
    for c in st["categories"]:
        role_t, role_d = ("static", "static") if c.get("is_other") else ("cat_title", "cat_description")
        items.append({"key": f"{c['id']}|title", "node": c["id"], "role": role_t, "text": c["title_pub"]})
        items.append({"key": f"{c['id']}|description", "node": c["id"], "role": role_d, "text": c["description_pub"]})
    items.append({"key": "workspace|name", "node": "workspace", "role": "static", "text": WORKSPACE_NAME})
    items.append({"key": "workspace|description", "node": "workspace", "role": "static", "text": WORKSPACE_DESCRIPTION})
    for i, u in enumerate(INTENDED_USES):
        items.append({"key": f"workspace|use{i}", "node": "workspace", "role": "static", "text": u})
    return items


def deterministic(items: list[dict], scanner: TokenScanner, corpus_texts: list[str]) -> dict[str, list[str]]:
    """(a)–(d) + numbers. Returns reasons per key (empty list = clean)."""
    ng = distinctive_ngrams({it["key"]: it["text"] for it in items}, corpus_texts)
    out = {}
    for it in items:
        t = it["text"]
        r = []
        if scanner.hits(t):
            r.append("fixture_token")
        r += [f"contact:{h}" for h in contact_hits(t)]
        r += [f"source_id:{h}" for h in source_id_hits(t)]
        if ng.get(it["key"]) and it["role"] != "static":
            r.append("distinctive_phrase")
        if it["role"] != "static" and has_number(t):
            r.append("number")
        if it["role"] in ("title", "cat_title") and util.words(t) > 8:
            r.append("too_long")
        if it["role"] in ("description", "cat_description") and sentences(t) > 2:
            r.append("too_long")
        out[it["key"]] = r
    return out


REASON_TEXT = {
    "fixture_token": "contains a name, contact detail or code word from a source conversation",
    "distinctive_phrase": "copies a distinctive phrase verbatim from a few source conversations",
    "number": "states a number, count or proportion",
    "too_long": "is too long for its role",
    "identifiability": "is specific enough that it could point to a small group of people",
}


def _reason_text(r: str) -> str:
    if r.startswith("contact:"):
        return "contains a contact detail, link, handle, file path or secret-like string"
    if r.startswith("source_id:"):
        return "contains an internal identifier or long number"
    if r.startswith("audit:"):
        return "privacy audit: " + r[6:]
    return REASON_TEXT.get(r, r)


def jev_ident(items: list[dict]) -> dict[str, float]:
    by_node: dict[str, list[dict]] = {}
    for it in items:
        if it["role"] != "static":
            by_node.setdefault(it["node"], []).append(it)

    def one(group: list[dict]) -> dict[str, float]:
        keys = {f"t{i}": it for i, it in enumerate(group)}
        ans = util.jev_ask({"report": "Aggregate usage report about a public AI-assistant dataset"},
                           ident_questions({k: it["text"] for k, it in keys.items()}))
        return {it["key"]: float(ans[k]["score"]) for k, it in keys.items()}

    res, _ = util.pmap(one, list(by_node.values()), settings().jev_concurrency, "gate-ident")
    out: dict[str, float] = {}
    for r in res:
        if r:
            out.update(r)
    return out


def glm_audit(items: list[dict], evidence_facets: dict[str, list[str]], dominated: set[str]) -> dict[str, dict]:
    by_node: dict[str, list[dict]] = {}
    for it in items:
        if it["role"] != "static":
            by_node.setdefault(it["node"], []).append(it)

    def one(node_items: tuple[str, list[dict]]) -> dict[str, dict]:
        node, group = node_items
        sys = AUDIT_SYS.format(strict=AUDIT_STRICT if node in dominated else "")
        lines = ["Items to audit:"] + [json.dumps({"key": it["key"], "role": it["role"], "text": it["text"]},
                                                  ensure_ascii=False) for it in group]
        ev = evidence_facets.get(node, [])
        if ev:
            lines += ["", "Evidence records from the cluster (generalized facets):"] + [f"- {f}" for f in ev]
        a = util.glm_json(sys, "\n".join(lines), Audit, model=GLM, reasoning="low", temperature=0.1, max_tokens=5000)
        return {x.key: x.model_dump() for x in a.items}

    res, _ = util.pmap(one, list(by_node.items()), settings().glm_concurrency, "gate-audit")
    out: dict[str, dict] = {}
    for r in res:
        if r:
            out.update(r)
    return out


def glm_rewrite(items: list[dict], reasons: dict[str, list[str]]) -> dict[str, str]:
    by_node: dict[str, list[dict]] = {}
    for it in items:
        by_node.setdefault(it["node"], []).append(it)

    def one(group: list[dict]) -> dict[str, str]:
        lines = [json.dumps({"key": it["key"], "role": it["role"], "text": it["text"],
                             "failed_because": sorted({_reason_text(r) for r in reasons[it["key"]]})}, ensure_ascii=False)
                 for it in group]
        rw = util.glm_json(REWRITE_SYS, "\n".join(lines), Rewrites, model=GLM, reasoning="low", temperature=0.3,
                           max_tokens=4000)
        return {x.key: x.text.strip() for x in rw.items}

    res, _ = util.pmap(one, list(by_node.values()), settings().glm_concurrency, "gate-rewrite")
    out: dict[str, str] = {}
    for r in res:
        if r:
            out.update(r)
    return out


def run(build: util.Build) -> dict:
    st = build.load("structure_described")
    priv = build.load("describe_private")
    dominated = set(priv.get("dominated", []))
    scanner = TokenScanner(fixtures.load_tokens())
    corpus = [r["text"] for r in util.load_rows(build.conv_ids, "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})").values()]
    facets = load_facets(build.conv_ids)
    ev_facets = {lid: [facets[c]["facet_text"] + (f" [fell short: {p['notes'][c]}]" if c in p.get("notes", {}) else "")
                       for c in p.get("records", []) if c in facets][:25]
                 for lid, p in priv["leaves"].items()}
    items = _items(st)
    by_key = {it["key"]: it for it in items}
    for it in items:
        it.update({"original": it["text"], "rewrites": 0, "status": "pending", "reasons_seen": []})
    initial: Counter = Counter()
    pending = list(items)
    for attempt in range(MAX_REWRITES + 1):
        det = deterministic(pending, scanner, corpus)
        ident = jev_ident(pending)
        # (e) the GLM audit is one rewriting pass over everything; rewritten text is then re-checked by the
        # deterministic checks and Jev (a re-audit loop would let an ever-unsatisfied auditor force roll-ups)
        audit = glm_audit(pending, ev_facets, dominated) if attempt == 0 else {}
        failing, reasons = [], {}
        for it in pending:
            r = list(det[it["key"]])
            if it["role"] != "static" and it["key"] not in ident:
                r.append("identifiability:unscored")  # fail closed when Jev returned no score
            elif ident.get(it["key"], 0.0) >= IDENT_MAX:
                r.append("identifiability")
            a = audit.get(it["key"])
            if attempt == 0 and it["role"] != "static" and a is None:
                r.append("audit:no verdict")  # fail closed when the auditor skipped an item
            elif a and a["verdict"] == "rewrite":
                r.append("audit:" + (a.get("reason") or "rewrite"))
            if attempt == 0:
                for x in r:
                    initial[x.split(":")[0]] += 1
                if r:
                    initial["texts_flagged"] += 1
            it["reasons_seen"].append(r)
            it["ident"] = ident.get(it["key"])
            if not r:
                it["status"] = "passed"
            elif it["role"] == "static":
                it["status"] = "static_failed"  # our own fixed text; surfaced loudly below
            else:
                failing.append(it)
                reasons[it["key"]] = r
        if not failing or attempt == MAX_REWRITES:
            for it in failing:
                it["status"] = "failed"
            break
        # prefer the auditor's own rewrite when the only objection came from the audit / Jev
        need_glm = []
        for it in failing:
            a = audit.get(it["key"])
            det_r = [x for x in reasons[it["key"]] if not x.startswith("audit:") and x != "identifiability"]
            if a and a["verdict"] == "rewrite" and a.get("rewrite") and not det_r:
                it["text"] = a["rewrite"].strip()
                it["rewrites"] += 1
            else:
                need_glm.append(it)
        if need_glm:
            rw = glm_rewrite(need_glm, reasons)
            for it in need_glm:
                if rw.get(it["key"]):
                    it["text"] = rw[it["key"]]
                it["rewrites"] += 1
        for it in failing:
            if it["role"] in LIMITS:
                it["text"] = util.clip_words(it["text"].rstrip("."), LIMITS[it["role"]])
        pending = failing

    static_failed = [it["key"] for it in items if it["status"] == "static_failed"]
    if static_failed:
        raise RuntimeError(f"gate: {len(static_failed)} fixed workspace texts fail the privacy checks; fix config_workspace")

    # ---- fallbacks and roll-ups
    leaves = {lf["id"]: lf for lf in st["leaves"]}
    cats = {c["id"]: c for c in st["categories"]}
    fallback = dropped = 0
    roll: list[str] = []
    for it in items:
        node, field = it["key"].split("|", 1)
        if node in leaves and not leaves[node]["is_other"]:
            lf = leaves[node]
            if field == "title":
                lf["title"] = it["text"]
            elif field == "description":
                lf["description_pub"] = it["text"]
            else:
                lst = lf["needs"] if field.startswith("n") else lf["problems"]
                for x in lst:
                    if x["id"] == field:
                        x["text"] = it["text"]
            if it["status"] == "failed":
                if field in ("title", "description"):
                    roll.append(node)
                elif field.startswith("n"):
                    lf["needs"] = [x for x in lf["needs"] if x["id"] != field]
                    dropped += 1
                else:
                    sig = it.get("signal")
                    generic = GENERIC_PROBLEM.get(sig)
                    if generic:
                        for x in lf["problems"]:
                            if x["id"] == field:
                                x["text"] = generic
                        fallback += 1
                    else:
                        lf["problems"] = [x for x in lf["problems"] if x["id"] != field]
                        dropped += 1
        elif node in cats and not cats[node].get("is_other"):
            c = cats[node]
            if field == "title":
                c["title_pub"] = it["text"] if it["status"] != "failed" else "Other uses in this area"
            else:
                c["description_pub"] = it["text"] if it["status"] != "failed" else "Related requests grouped together."
            if it["status"] == "failed":
                fallback += 1

    rolled = rollup(build, st, sorted(set(roll)))
    # renumber evidence ids after drops (n1.., p1.. unique within a cluster); keep the private evidence map in sync
    evidence = build.load("evidence")
    for lf in st["leaves"]:
        ev_old = evidence.get(lf["id"], {})
        ev_new = {}
        for prefix, key in (("n", "needs"), ("p", "problems")):
            for i, x in enumerate(lf.get(key, [])):
                new_id = f"{prefix}{i + 1}"
                ev_new[new_id] = ev_old.get(x["id"], [])
                x["id"] = new_id
        evidence[lf["id"]] = ev_new
    build.save("evidence", evidence)
    build.save("structure_final", st)
    build.save("gate_private", {"items": [{k: it.get(k) for k in ("key", "role", "status", "rewrites", "ident", "reasons_seen")}
                                          for it in items], "rolled_up": rolled, "dominated": sorted(dominated)})
    counts = {
        "texts_checked": len(items),
        "passed_first": sum(1 for it in items if it["status"] == "passed" and it["rewrites"] == 0),
        "rewritten": sum(1 for it in items if it["rewrites"] > 0 and it["status"] == "passed"),
        "failed_after_rewrites": sum(1 for it in items if it["status"] == "failed"),
        "replaced_general": fallback, "dropped": dropped, "rolled_up": len(rolled),
        "dominated_clusters": len(dominated),
        **{f"initial_{k}": v for k, v in initial.items()},
    }
    build.info["gate"] = counts
    return counts


def rollup(build: util.Build, st: dict, leaf_ids: list[str]) -> list[dict]:
    """Merge each failing leaf into its nearest sibling (same category, centroid cosine); if it has no
    sibling, into cl_other. Metrics are computed later (stats stage) from the merged theme ids."""
    if not leaf_ids:
        return []
    members = leaf_members(build, st["leaves"])
    cents = leaf_centroids(build, members)
    out = []
    for lid in leaf_ids:
        leaves = {lf["id"]: lf for lf in st["leaves"]}
        lf = leaves.get(lid)
        if lf is None:
            continue
        sibs = [x for x in st["leaves"] if x["parent_id"] == lf["parent_id"] and x["id"] != lid and not x["is_other"]]
        target = None
        if sibs and lid in cents:
            target = max(sibs, key=lambda x: float(cents[lid] @ cents[x["id"]]) if x["id"] in cents else -2)
        if target is None:
            target = leaves["cl_other"]
        target["theme_ids"] = target["theme_ids"] + lf["theme_ids"]
        st["leaves"] = [x for x in st["leaves"] if x["id"] != lid]
        out.append({"leaf": lid, "into": target["id"]})
    con = db.private()
    with db.write(con):
        for r in out:
            tgt = next(x for x in st["leaves"] if x["id"] == r["into"])
            for tid in tgt["theme_ids"]:
                con.execute("UPDATE themes SET category_id = ? WHERE build_id = ? AND theme_id = ?",
                            (tgt["parent_id"], build.build_id, tid))
    # a category left without leaves disappears
    parents = {lf["parent_id"] for lf in st["leaves"]}
    st["categories"] = [c for c in st["categories"] if c["id"] in parents]
    return out
