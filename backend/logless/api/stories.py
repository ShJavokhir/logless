"""Fictional user stories: one published cluster in, 90–140 validated words out.

GLM 5.3 (temperature 0.7, reasoning low) sees ONLY the published cluster — title, description,
needs, problems with their evidence ids, and its public metrics. There is no retrieval. The
story is validated (length, citations ⊆ the cluster's evidence ids, no digits, no contact
details, no canary tokens, no occupations / diagnoses / ages / exact places), with one repair
attempt, and cached per (snapshot, cluster)."""
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

log = logging.getLogger("logless.api")
LABEL = "Fictional user story. Illustrates an aggregate pattern; not a real customer or additional evidence."
MIN_WORDS, MAX_WORDS = 90, 140
MARKER = re.compile(r"\[([np][1-9]\d{0,2})\]")
NAME = re.compile(r"^[A-Z][a-z]{1,15}$")

# Cheap specificity lists (the spec: no occupations, diagnoses, exact places, ages or family histories).
OCCUPATIONS = {
    "nurse", "doctor", "physician", "surgeon", "teacher", "professor", "lawyer", "attorney", "accountant", "engineer",
    "developer", "programmer", "architect", "pharmacist", "dentist", "therapist", "psychologist", "firefighter",
    "police", "officer", "soldier", "pilot", "chef", "cashier", "plumber", "electrician", "journalist", "banker",
    "consultant", "ceo", "founder", "manager", "secretary", "receptionist", "mechanic", "farmer", "scientist",
    "researcher", "designer", "photographer", "salesperson", "realtor", "paramedic", "veterinarian", "librarian",
}
DIAGNOSES = {
    "diabetes", "cancer", "depression", "depressed", "anxiety", "adhd", "autism", "autistic", "dementia", "alzheimer",
    "alzheimer's", "bipolar", "schizophrenia", "ptsd", "hiv", "aids", "asthma", "epilepsy", "arthritis", "covid",
    "pregnant", "pregnancy", "disorder", "syndrome", "diagnosed", "diagnosis", "chemotherapy", "tumor", "stroke",
}
PLACES = {
    "london", "paris", "berlin", "tokyo", "beijing", "shanghai", "moscow", "delhi", "mumbai", "new york", "los angeles",
    "san francisco", "chicago", "toronto", "sydney", "madrid", "rome", "istanbul", "cairo", "lagos", "nairobi", "seoul",
    "singapore", "dubai", "mexico city", "sao paulo", "são paulo", "buenos aires", "kyiv", "kiev", "warsaw", "hong kong",
    "america", "china", "india", "russia", "germany", "france", "japan", "brazil", "canada", "mexico", "ukraine",
    "england", "britain", "australia", "nigeria", "egypt", "iran", "turkey", "spain", "italy", "korea", "vietnam",
    "street", "avenue",
}
AGE_WORDS = re.compile(r"(?i)\b(years? old|year-old|aged|in (?:his|her|their) (?:teens|twenties|thirties|forties|fifties|sixties|seventies|eighties))\b")
STAT_WORDS = re.compile(r"(?i)\b(percent|percentage|per cent|most users|majority of|statistic)\b")


class _StoryOut(BaseModel):
    first_name: str
    text: str
    citations: list[str]


def cluster_input(node: dict) -> dict:
    """Exactly the published fields the model may see."""
    f = node["friction"]
    return {
        "title": node["title"], "description": node["description"],
        "needs": [{"id": n["id"], "text": n["text"]} for n in node.get("needs") or []],
        "problems": [{"id": p["id"], "text": p["text"], "signal": p.get("signal"),
                      "support": "seen in several people's conversations" if p.get("support") == "common" else "an observed request (limited support)"}
                     for p in node.get("problems") or []],
        "metrics": {"conversations": node["conversations"], "share_of_all_conversations": node["share"],
                    "friction_share": f.get("share"),
                    "signals_observed": {s: int((f.get("signals") or {}).get(s, 0)) for s in ("correction", "repeat_request", "assistant_limit", "complaint")}},
    }


SYSTEM = (
    "You write a short fictional user story that makes one published usage pattern concrete for a product team. "
    "Rules: 90 to 140 words. Invent one first name (a common first name, letters only) and a minimal setting. Say what "
    "the person wants, using only the needs given. Mention ONLY frustrations that appear in the problems list; if the "
    "problems list is empty, say that no specific frustration is established. Cite the evidence for each need or "
    "frustration inline with its id in square brackets, e.g. [n1] or [p2], using only ids from the input. Never write "
    "digits, numbers, percentages or statistics. No occupation, job title, medical condition, age, family history, "
    "company, city, country or other exact place, no contact details and no links. Write in English, third person, "
    "plain prose."
)


def validate(story: _StoryOut, node: dict) -> tuple[list[str], dict]:
    """Returns (problems, cleaned). Problem strings are ours (fixed vocabulary)."""
    evidence = {x["id"] for x in (node.get("needs") or []) + (node.get("problems") or [])}
    problem_ids = {x["id"] for x in node.get("problems") or []}
    text = " ".join(story.text.split())
    name = story.first_name.strip()
    probs: list[str] = []
    markers = MARKER.findall(text)
    bare = MARKER.sub("", text)
    words = len(re.findall(r"[A-Za-zÀ-ÿ'’-]+", bare))
    if not (MIN_WORDS <= words <= MAX_WORDS):
        probs.append(f"length must be {MIN_WORDS}-{MAX_WORDS} words (it was {words})")
    if not NAME.match(name):
        probs.append("first_name must be one capitalised first name, letters only")
    elif name not in text:
        probs.append("the story must use the first name")
    unknown = sorted(set(markers) - evidence)
    if unknown:
        probs.append("cites evidence ids that do not exist in this cluster: " + ", ".join(unknown))
    if evidence and not markers:
        probs.append("cite the evidence inline, e.g. [n1]")
    if set(story.citations) - evidence:
        probs.append("citations list contains ids that do not exist in this cluster")
    if not problem_ids and "frustration" not in bare.lower():
        probs.append("say that no specific frustration is established (the cluster has no supported problems)")
    if re.search(r"\d", bare) or re.search(r"\d", name):
        probs.append("no digits or numbers")
    if STAT_WORDS.search(bare) or "%" in bare:
        probs.append("no statistics or percentages")
    low = f" {bare.lower()} "
    toks = set(re.findall(r"[a-z']+", low))
    if toks & OCCUPATIONS:
        probs.append("no occupations or job titles")
    if toks & DIAGNOSES:
        probs.append("no medical conditions")
    if any(p in low for p in PLACES if " " in p) or toks & {p for p in PLACES if " " not in p}:
        probs.append("no cities, countries or exact places")
    if AGE_WORDS.search(bare):
        probs.append("no ages")
    leak = leakcheck.problems(text) + leakcheck.problems(name)
    if leak:
        probs.append("no contact details, links or identifiers")  # canary hits are reported the same way
    cleaned = {"first_name": name, "text": text, "citations": list(dict.fromkeys(markers))}
    return probs, cleaned


def cached(snapshot_id: str, cluster_id: str) -> dict | None:
    row = db.public().execute("SELECT json FROM stories WHERE snapshot_id=? AND cluster_id=?", (snapshot_id, cluster_id)).fetchone()
    return json.loads(row["json"]) if row else None


def _save(story: dict) -> None:
    con = db.public()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO stories(snapshot_id, cluster_id, json, created_at) VALUES (?,?,?,?)",
                    (story["snapshot_id"], story["cluster_id"], json.dumps(story), story["generated_at"]))


def run_story(run: Run, *, snapshot_id: str, node: dict) -> None:
    try:
        _run(run, snapshot_id, node)
    except ProviderError as e:
        run.fail("model_unavailable", f"The story model is unavailable ({e.provider}).")
    except Exception as e:  # noqa: BLE001
        log.error("story %s crashed: %s", run.id, type(e).__name__)
        run.fail("internal_error", "The story could not be generated.")


def _run(run: Run, snapshot_id: str, node: dict) -> None:
    user = "Published cluster:\n" + json.dumps(cluster_input(node), ensure_ascii=False, indent=1) + \
        '\nReturn {"first_name": "...", "text": "...", "citations": ["n1", ...]}.'
    problems: list[str] = []
    for attempt in (1, 2):
        if attempt == 2:
            run.insert_stages(["writing", "checking"])   # one repair round, same stage names
        run.state("planning")
        run.stage("writing", "running", "GLM 5.3 sees only this published cluster (no retrieval, no records)" if attempt == 1
                  else "one repair attempt with the validator's feedback")
        prompt = user if attempt == 1 else user + "\nYour previous story was rejected: " + "; ".join(problems) + ". Write a new one."
        try:
            out, meta = glm.chat_json(SYSTEM, prompt, _StoryOut, reasoning="low", temperature=0.7, max_tokens=1200, use_cache=False)
        except glm.GLMOutputError:
            out, meta = None, {}
        run.stage("writing", "done" if out else "failed", f"{meta.get('model', glm.GLM)} wrote a draft" if out else "no valid JSON from the model")
        run.state("validating")
        run.stage("checking", "running", "length, evidence ids, no numbers, no specifics, canary and contact checks")
        if out is None:
            problems = ["return valid JSON"]
        else:
            problems, cleaned = validate(out, node)
        if not problems:
            story = {"cluster_id": node["id"], "snapshot_id": snapshot_id, "label": LABEL, "first_name": cleaned["first_name"],
                     "text": cleaned["text"], "citations": cleaned["citations"], "model": meta.get("model", glm.GLM),
                     "generated_at": utcnow()}
            _save(story)
            run.stage("checking", "done", f"passed ({len(cleaned['citations'])} evidence ids cited)")
            run.complete()
            return
        run.stage("checking", "failed", "rejected: " + "; ".join(problems)[:300])
    run.fail("story_rejected", "The generated story did not pass validation after one repair attempt, so it is not shown.")
