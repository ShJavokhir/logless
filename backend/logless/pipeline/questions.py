"""Jev question wording, versioned. Changing any wording must bump its version string.

The friction wording was tuned on a 120-conversation real-data pilot (docs/CONTRACTS.md §3)."""
from __future__ import annotations

SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")
TRI = ("observed", "not_observed", "unclear")

FRICTION_QV = "f1"
FRICTION_Q: dict[str, dict] = {
    "correction": {"type": "choice",
        "instructions": "In `conversation`, does the user point out that an assistant answer was wrong, broken or not what they asked for (a factual error, buggy code, ignored constraint, wrong format)?",
        "criteria": {"observed": "The user explicitly says or clearly shows that a previous assistant answer was wrong or did not follow their request",
                     "not_observed": "No such correction; new requests, follow-ups, extra details or the user changing their own mind do not count",
                     "unclear": "Something might be a correction but it cannot be told from the text"}},
    "repeat_request": {"type": "choice",
        "instructions": "In `conversation`, does the user repeat or rephrase essentially the same request because a previous assistant answer did not satisfy it?",
        "criteria": {"observed": "The user re-asks or rephrases the same request after an assistant answer, implying it fell short",
                     "not_observed": "No repeated request; asking for more, a variation, or a new item counts as not observed",
                     "unclear": "A repeat is possible but its reason cannot be told from the text"}},
    "assistant_limit": {"type": "choice",
        "instructions": "In `conversation`, does the assistant decline or fail to do what the user asked because of a limitation or policy (no internet or real-time data, cannot open links or files, cannot generate images, refuses the request)?",
        "criteria": {"observed": "The assistant does not do the requested task and cites a limitation, lack of access or a policy",
                     "not_observed": "The assistant does the task; a disclaimer such as 'As an AI language model…' followed by an answer does not count",
                     "unclear": "It is not clear whether the requested task was declined"}},
    "complaint": {"type": "choice",
        "instructions": "In `conversation`, does the user express frustration or dissatisfaction with the assistant itself?",
        "criteria": {"observed": "The user complains about the assistant's answers or behaviour (e.g. 'that's useless', 'you keep doing this', 'stop apologizing')",
                     "not_observed": "No complaint about the assistant; complaints about other people, life or third-party tools do not count",
                     "unclear": "Tone suggests dissatisfaction but it is not clearly aimed at the assistant"}},
}

# Care signals: what a safety or trust team needs per theme. They are stored in the friction table under
# their own version and never count toward friction share (a policy refusal is not a product failure).
CARE = ("refusal", "sensitive")
CARE_QV = "c1"
CARE_Q: dict[str, dict] = {
    "refusal": {"type": "choice",
        "instructions": "In `conversation`, does the assistant decline all or part of the request on policy, safety or ethical grounds?",
        "criteria": {"observed": "The assistant refuses, partly refuses or redirects the request because it considers it harmful, unsafe, unethical or against its rules",
                     "not_observed": "The assistant does the task; declining for lack of ability or access (no internet, cannot open files) does not count",
                     "unclear": "The assistant may have declined on policy grounds but it cannot be told from the text"}},
    "sensitive": {"type": "choice",
        "instructions": "In `conversation`, does the user bring up a sensitive personal situation: self-harm or a crisis, a medical or mental-health concern, legal trouble, abuse, or the safety of a child?",
        "criteria": {"observed": "The user describes such a situation affecting themselves or someone they know",
                     "not_observed": "No such situation; fiction, schoolwork or general questions about these topics do not count",
                     "unclear": "Such a situation is possible but cannot be told from the text"}},
}

PII_QV = "pii1"
PII_Q: dict[str, dict] = {
    "identifying": {"type": "noul", "instructions": (
        "Does `facet` contain a name, contact detail, exact place, organization or other identifying detail? "
        "Counts: a person's name or username, an email, phone number, street address or handle, a specific small town, "
        "street, school or building, a named employer or private organization, an exact date, an ID or account number, or "
        "the title of a private document or unpublished work. Does not count: programming languages, software products, "
        "public platforms and brands, famous public figures, fictional characters, well-known books, films or games, "
        "countries and large cities.")},
}

CLASSIFY_QV = "cl1"
OTHER_LABEL = "Other or unclear"


def theme_question(themes: list[dict]) -> dict:
    """One Choice over all active themes (+ Other or unclear). Option names are theme names."""
    criteria: dict[str, dict | str] = {}
    for t in themes:
        if t["name"] in criteria or t["name"] == OTHER_LABEL:
            raise ValueError("theme choices require unique names distinct from the catch-all label")
        criteria[t["name"]] = {"description": t.get("description") or "",
                               "includes": t.get("includes") or "", "excludes": t.get("excludes") or ""}
    criteria[OTHER_LABEL] = {"description": "None of the other themes clearly fits what the user wants, the request is "
                                            "empty or unintelligible, or it genuinely spans several themes equally."}
    return {"theme": {"type": "choice",
                      "instructions": "Which theme best describes what the user is trying to get done in `conversation`? "
                                      "`facets` is a generalized summary of the same conversation. Choose by the user's goal, "
                                      "not by the language of the conversation.",
                      "criteria": criteria}}


HIERARCHY_QV = "hq1"


def category_question(categories: list[dict]) -> dict:
    return {"category": {"type": "choice",
                         "instructions": "Which top-level category should the usage theme in `theme` be filed under?",
                         "criteria": {c["title"]: c.get("description") or "" for c in categories}}}


IDENT_QV = "id1"
IDENT_LEVELS = [
    "Generic: describes a broad pattern that many unrelated people share; no specific person, place, organization or event",
    "Mostly generic: mentions a common topic or product but nothing that narrows it to a small group",
    "Specific: combines details (a niche situation, a particular event, a rare combination of attributes) that could point to a small group of people",
    "Identifying: names or clearly points to a specific person, organization, place, account or private document",
]


def ident_questions(texts: dict[str, str]) -> dict:
    """Score 0–3 per text; question ids are opaque keys."""
    return {k: {"type": "score",
                "instructions": {"published_text": v,
                                 "question": "How identifying is `published_text`, a sentence that will be published in an aggregate report about how many people use an AI assistant?"},
                "criteria": IDENT_LEVELS} for k, v in texts.items()}


SURPRISE_QV = "su1"
SURPRISE_CRITERIA = {
    "covered": "The workflow is squarely one of the intended uses",
    "partly_covered": "The workflow overlaps an intended use but goes beyond it in purpose, format or domain",
    "not_covered": "The workflow is not among the intended uses; the assistant's designers probably did not plan for it",
}


def surprise_questions(keys: list[str]) -> dict:
    return {k: {"type": "choice",
                "instructions": f"Is the workflow `workflows.{k}` one of the assistant's `intended_uses`?",
                "criteria": SURPRISE_CRITERIA} for k in keys}


QUESTION_VERSIONS = {"friction": FRICTION_QV, "care": CARE_QV, "pii": PII_QV, "classify": CLASSIFY_QV, "hierarchy_refile": HIERARCHY_QV,
                     "identifiability": IDENT_QV, "surprising": SURPRISE_QV}
