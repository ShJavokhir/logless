"""PRD drafts: one published cluster in, a one-page product brief out, for the eng team.

GLM 5.3 sees ONLY the published cluster (the same fields as stories.cluster_input) and writes
the prose: problem, user stories, requirements, success metrics. It may not write a single
digit. Every number in the brief is a {placeholder} that this module fills from the published,
reconciled cluster metrics, and the roadmap priority is computed here from published counts,
not by the model. Validated (evidence ids ⊆ the cluster's, placeholders ⊆ the allowlist, story
shape, no specifics, canary and contact checks), with one repair attempt, and cached per
(snapshot, cluster)."""
from __future__ import annotations

import json
import logging
import re

from pydantic import BaseModel

from .. import db
from ..ids import utcnow
from ..providers import glm
from ..providers.http import ProviderError
from ..sandbox.runs import Run
from . import leakcheck
from .stories import AGE_WORDS, DIAGNOSES, MARKER, PLACES, cluster_input

log = logging.getLogger("logless.api")
LABEL = ("Draft PRD · Written by GLM 5.3 from this workflow's published aggregates only. Every number is filled "
         "from published metrics and the priority is computed from published counts, not by the model.")
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
P0_TOP, P1_TOP = 5, 15   # rank by conversations with friction among ranked workflows


class _PrdOut(BaseModel):
    title: str
    problem: str
    user_stories: list[str]
    requirements: list[str]
    success_metrics: list[str]


def _pct(x) -> str:
    return "n/a" if x is None else f"{float(x) * 100:.1f}%"


def placeholder_values(node: dict) -> dict[str, str]:
    """The only numbers a PRD can contain, formatted from the published cluster."""
    f = node.get("friction") or {}
    sig = f.get("signals") or {}
    vals = {
        "conversations": f"{int(node['conversations']):,}",
        "people": f"{int(node.get('users') or 0):,}",
        "share_of_all": _pct(node.get("share")),
        "friction_share": _pct(f.get("share")),
        "friction_conversations": f"{int(f.get('conversations') or 0):,}",
    }
    for s in ("correction", "repeat_request", "assistant_limit", "complaint"):
        vals[s] = f"{int(sig.get(s, 0)):,}"
    return vals


def rankable(clusters: list[dict]) -> list[dict]:
    """Published workflows that can be prioritised: leaves outside Other or unclear."""
    cats = {c["id"]: c for c in clusters if int(c["level"]) == 1}
    return [c for c in clusters if int(c["level"]) == 2 and c["id"] != "cl_other" and not c.get("is_other")
            and not (cats.get(c.get("parent_id")) or {}).get("is_other")]


def priority(node: dict, clusters: list[dict]) -> dict:
    """Roadmap priority from published counts only: rank by conversations with a friction signal."""
    pool = sorted(rankable(clusters), key=lambda c: (-int((c.get("friction") or {}).get("conversations") or 0), c["id"]))
    ids = [c["id"] for c in pool]
    if node["id"] not in ids:
        return {"level": None, "rank": None, "of": len(ids),
                "basis": "Other or unclear is not prioritised; re-cluster it first."}
    rank = ids.index(node["id"]) + 1
    level = "P0" if rank <= P0_TOP else "P1" if rank <= P1_TOP else "P2"
    return {"level": level, "rank": rank, "of": len(ids),
            "basis": f"Ranks {rank} of {len(ids)} workflows by conversations with a friction signal "
                     f"(P0 = top {P0_TOP}, P1 = top {P1_TOP})."}


SYSTEM = (
    "You draft a short product requirements document (PRD) for an engineering team from ONE published usage "
    "pattern of a chat assistant. Use only the needs and problems given; never invent new facts about users.\n"
    "Fields:\n"
    "- title: a feature or fix name, 3 to 10 words.\n"
    "- problem: 2 to 4 sentences on what users need and where the assistant fails them. Cite problems inline, "
    "e.g. [p2]. If the problems list is empty, say that no specific frustration is established yet.\n"
    "- user_stories: 2 to 4 items, each exactly in the form 'As a <kind of user>, I want <goal> so that <benefit>.' "
    "and each citing at least one need or problem id inline, e.g. [n1].\n"
    "- requirements: 3 to 5 concrete things the team should build or change, each citing at least one id.\n"
    "- success_metrics: 2 to 4 measurable targets. Each must reference at least one metric placeholder for its "
    "baseline, e.g. 'Cut conversations with a correction below today's {correction}.'\n"
    "NUMBERS: never write digits, numbers, percentages or number words yourself. When you need a figure, write one "
    "of these placeholders exactly and it will be filled from verified metrics: {conversations} (conversations in "
    "this workflow), {people} (distinct people), {share_of_all} (share of all conversations), {friction_share} "
    "(share with any friction signal), {friction_conversations}, {correction}, {repeat_request}, {assistant_limit}, "
    "{complaint} (conversations with that signal).\n"
    "No occupations tied to a real person, no medical conditions, ages, companies, cities, countries, contact "
    "details or links. English, concise, plain text (no markdown)."
)


def _text_problems(field: str, text: str, evidence: set[str], allowed: set[str]) -> list[str]:
    probs = []
    bare = PLACEHOLDER.sub("", MARKER.sub("", text))
    if re.search(r"\d", bare) or "%" in bare:
        probs.append(f"{field}: no digits or percentages — use the placeholders")
    unknown = sorted(set(MARKER.findall(text)) - evidence)
    if unknown:
        probs.append(f"{field}: cites ids that do not exist in this cluster: " + ", ".join(unknown))
    bad = sorted(set(PLACEHOLDER.findall(text)) - allowed)
    if bad:
        probs.append(f"{field}: unknown placeholders: " + ", ".join("{" + b + "}" for b in bad))
    if "{" in PLACEHOLDER.sub("", text) or "}" in PLACEHOLDER.sub("", text):
        probs.append(f"{field}: braces are only for placeholders")
    low = f" {bare.lower()} "
    toks = set(re.findall(r"[a-z']+", low))
    if toks & DIAGNOSES:
        probs.append(f"{field}: no medical conditions")
    if any(p in low for p in PLACES if " " in p) or toks & {p for p in PLACES if " " not in p}:
        probs.append(f"{field}: no cities, countries or exact places")
    if AGE_WORDS.search(bare):
        probs.append(f"{field}: no ages")
    if len(bare.split()) > 90:
        probs.append(f"{field}: too long")
    return probs


GROUPED = re.compile(r"\[\s*[np]\d+(?:\s*[,;/]\s*[np]\d+)+\s*\]")   # "[n1, p2]" -> "[n1] [p2]"
STORY_SHAPE = re.compile(r"(?is)^as an? .+?,\s*i want .+? so that .+")


def validate(out: _PrdOut, node: dict) -> tuple[list[str], dict]:
    """Returns (problems, filled). Problem strings are ours (fixed vocabulary)."""
    evidence = {x["id"] for x in (node.get("needs") or []) + (node.get("problems") or [])}
    problem_ids = {x["id"] for x in node.get("problems") or []}
    values = placeholder_values(node)
    allowed = set(values)
    clean = lambda s: " ".join(GROUPED.sub(lambda m: " ".join(f"[{x}]" for x in re.findall(r"[np]\d+", m.group(0))),
                                          str(s)).split())  # noqa: E731
    doc = {"title": clean(out.title), "problem": clean(out.problem),
           "user_stories": [clean(s) for s in out.user_stories], "requirements": [clean(s) for s in out.requirements],
           "success_metrics": [clean(s) for s in out.success_metrics]}
    probs: list[str] = []
    if not (3 <= len(doc["title"].split()) <= 12):
        probs.append("title must be 3-12 words")
    for field, lo, hi in (("user_stories", 2, 4), ("requirements", 3, 5), ("success_metrics", 2, 4)):
        if not (lo <= len(doc[field]) <= hi):
            probs.append(f"{field} must have {lo}-{hi} items")
    probs += _text_problems("title", doc["title"], set(), set())
    probs += _text_problems("problem", doc["problem"], evidence, allowed)
    if problem_ids and not set(MARKER.findall(doc["problem"])) & problem_ids:
        probs.append("problem: cite at least one problem id, e.g. [p1]")
    for field in ("user_stories", "requirements", "success_metrics"):
        for i, s in enumerate(doc[field], 1):
            probs += _text_problems(f"{field}[{i}]", s, evidence, allowed)
            if field != "success_metrics" and evidence and not MARKER.findall(s):
                probs.append(f"{field}[{i}]: cite at least one id, e.g. [n1]")
    for i, s in enumerate(doc["user_stories"], 1):
        if not STORY_SHAPE.match(MARKER.sub("", s).strip()):
            probs.append(f"user_stories[{i}]: use 'As a <user>, I want <goal> so that <benefit>.'")
    for i, s in enumerate(doc["success_metrics"], 1):
        if not PLACEHOLDER.search(s):
            probs.append(f"success_metrics[{i}]: reference a metric placeholder for the baseline")
    fill = lambda s: PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), s)  # noqa: E731
    filled = {k: ([fill(x) for x in v] if isinstance(v, list) else fill(v)) for k, v in doc.items()}
    flat = " ".join([filled["title"], filled["problem"], *filled["user_stories"], *filled["requirements"],
                     *filled["success_metrics"]])
    if leakcheck.problems(flat):
        probs.append("no contact details, links or identifiers")
    used = sorted({p for s in [doc["problem"], *doc["user_stories"], *doc["requirements"], *doc["success_metrics"]]
                   for p in PLACEHOLDER.findall(s) if p in values})
    cites = list(dict.fromkeys(MARKER.findall(" ".join([doc["problem"], *doc["user_stories"], *doc["requirements"]]))))
    filled["citations"] = cites
    filled["metrics_used"] = [{"name": p, "value": values[p]} for p in used]
    return probs, filled


def cached(snapshot_id: str, cluster_id: str) -> dict | None:
    row = db.public().execute("SELECT json FROM prds WHERE snapshot_id=? AND cluster_id=?", (snapshot_id, cluster_id)).fetchone()
    return json.loads(row["json"]) if row else None


def _save(prd: dict) -> None:
    con = db.public()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO prds(snapshot_id, cluster_id, json, created_at) VALUES (?,?,?,?)",
                    (prd["snapshot_id"], prd["cluster_id"], json.dumps(prd), prd["generated_at"]))


def run_prd(run: Run, *, snapshot_id: str, node: dict, clusters: list[dict]) -> None:
    try:
        _run(run, snapshot_id, node, clusters)
    except ProviderError as e:
        run.fail("model_unavailable", f"The PRD model is unavailable ({e.provider}).")
    except Exception as e:  # noqa: BLE001
        log.error("prd %s crashed: %s", run.id, type(e).__name__)
        run.fail("internal_error", "The PRD could not be drafted.")


def _run(run: Run, snapshot_id: str, node: dict, clusters: list[dict]) -> None:
    user = "Published cluster:\n" + json.dumps(cluster_input(node), ensure_ascii=False, indent=1) + \
        '\nReturn {"title": "...", "problem": "...", "user_stories": [...], "requirements": [...], "success_metrics": [...]}.'
    problems: list[str] = []
    for attempt in (1, 2):
        if attempt == 2:
            run.insert_stages(["drafting", "checking"])   # one repair round, same stage names
        run.state("planning")
        run.stage("drafting", "running", "GLM 5.3 sees only this published workflow (no retrieval, no records)" if attempt == 1
                  else "one repair attempt with the validator's feedback")
        prompt = user if attempt == 1 else user + "\nYour previous draft was rejected: " + "; ".join(problems)[:1500] + ". Write a new one."
        try:
            out, meta = glm.chat_json(SYSTEM, prompt, _PrdOut, reasoning="low", temperature=0.4,
                                      max_tokens=2500, use_cache=False, retries=0, timeout=60.0, attempts=1)
        except glm.GLMOutputError:
            out, meta = None, {}
        run.stage("drafting", "done" if out else "failed", f"{meta.get('model', glm.GLM)} wrote a draft" if out else "no valid JSON from the model")
        run.state("validating")
        run.stage("checking", "running", "evidence ids, number placeholders, story shape, no specifics, canary and contact checks")
        if out is None:
            problems = ["return valid JSON"]
        else:
            problems, filled = validate(out, node)
        if not problems:
            prd = {"cluster_id": node["id"], "snapshot_id": snapshot_id, "label": LABEL, **filled,
                   "priority": priority(node, clusters), "model": meta.get("model", glm.GLM), "generated_at": utcnow()}
            _save(prd)
            run.stage("checking", "done", f"passed ({len(filled['citations'])} evidence ids, "
                                          f"{len(filled['metrics_used'])} verified numbers filled in)")
            run.complete()
            return
        run.stage("checking", "failed", "rejected: " + "; ".join(problems)[:300])
    run.fail("prd_rejected", "The drafted PRD did not pass validation after one repair attempt, so it is not shown.")
