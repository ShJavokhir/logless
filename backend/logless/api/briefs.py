"""Video brief (docs/VIDEO_BRIEF.md): a one-minute storyboard of the published map, directed by GLM 5.3.

GLM sees ONLY a compact facts sheet built from the published snapshot (the aggregates the map
shows, plus the published workflow titles, descriptions, needs and problems). It returns a
storyboard: scene types, order, seconds and the words on screen. It may not write a digit, a
percent sign or a number word; every figure is a {placeholder} this module fills from published
metrics, and the data each scene visualises is attached here from the snapshot, never by the
model. The gate is plain code with fixed-vocabulary problem strings, one repair round, and the
result is stored in public.db.briefs (latest wins)."""
from __future__ import annotations

import json
import logging
import re
import sqlite3

from pydantic import BaseModel

from .. import db
from ..ids import brief_id, utcnow
from ..providers import glm
from ..providers.http import ProviderError
from ..sandbox.runs import Run
from . import leakcheck
from .prds import PLACEHOLDER, _pct, rankable
from .stories import AGE_WORDS, DIAGNOSES, PLACES

log = logging.getLogger("logless.api")
LABEL = ("Video brief · Directed by GLM 5.3 from published aggregates only. "
         "Every number is filled from published metrics.")
FPS, WIDTH, HEIGHT = 30, 1920, 1080
PIPELINE = "GLM 5.3 · Jev · gVisor sandbox"
TYPES = ("intro", "change", "map", "top_workflows", "friction", "signals", "spotlight", "languages", "takeaways", "outro")
SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")
SIGNAL_LABELS = {"correction": "Corrected the assistant", "repeat_request": "Asked again",
                 "assistant_limit": "Assistant couldn't help", "complaint": "Complained"}
GLOBAL_PH = ("conversations", "people", "languages", "friction_share", "top_workflow", "top_workflow_share",
             "hotspot", "hotspot_friction_share")
SPOT_PH = ("share", "friction_share_here", "conversations_here", "people_here")
CHANGE_PH = ("new_conversations", "fastest_growing", "friction_share_before")   # only after an intake
NAME_PH = {"top_workflow", "hotspot", "fastest_growing"}      # filled with a published short title, not a number
TOP_N = 6
MIN_RATE_BASE = 50      # friction-share ranking in the facts sheet only counts workflows this large
MIN_SCENES, MAX_SCENES = 6, 10
MIN_SEC, MAX_SEC, MIN_TOTAL, MAX_TOTAL = 3, 12, 50, 62
_NUM = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
        "seventeen eighteen nineteen twenty dozen hundred thousand million billion half twice double triple quarter "
        "third percent majority most minority").split()
NUMBER_WORDS = set(_NUM) | {"dozens", "hundreds", "thousands", "millions", "billions", "halves", "quarters", "thirds",
                             "doubles", "doubled", "tripled", "percentage", "percentages"}


class _SceneOut(BaseModel):
    type: str
    seconds: int
    headline: str = ""
    kicker: str | None = None
    cluster_id: str | None = None
    insight: str | None = None
    bullets: list[str] | None = None


class _BriefOut(BaseModel):
    title: str
    scenes: list[_SceneOut]


# ---------------------------------------------------------------- published figures

def _fr(node: dict) -> dict:
    return node.get("friction") or {}


def _fconv(node: dict) -> int:
    return int(_fr(node).get("conversations") or 0)


def _by_conversations(snapshot: dict) -> list[dict]:
    return sorted(rankable(snapshot["clusters"]), key=lambda c: (-int(c["conversations"]), c["id"]))


def _by_friction(snapshot: dict) -> list[dict]:
    return sorted(rankable(snapshot["clusters"]), key=lambda c: (-_fconv(c), -int(c["conversations"]), c["id"]))


def _short(node: dict) -> str:
    return node.get("short_title") or node["title"]


def global_values(snapshot: dict) -> dict[str, str]:
    t, ds = snapshot["totals"], snapshot["dataset"]
    vals = {"conversations": f"{int(t['conversations']):,}", "people": f"{int(t['users']):,}",
            "languages": f"{int(ds['languages']):,}", "friction_share": _pct(_fr(t).get("share"))}
    top, hot = _by_conversations(snapshot), _by_friction(snapshot)
    if top:
        vals["top_workflow"], vals["top_workflow_share"] = _short(top[0]), _pct(top[0].get("share"))
    if hot:
        vals["hotspot"], vals["hotspot_friction_share"] = _short(hot[0]), _pct(_fr(hot[0]).get("share"))
    return vals


def spot_values(node: dict) -> dict[str, str]:
    return {"share": _pct(node.get("share")), "friction_share_here": _pct(_fr(node).get("share")),
            "conversations_here": f"{int(node['conversations']):,}", "people_here": f"{int(node.get('users') or 0):,}"}


def baseline(snapshot: dict) -> dict | None:
    """The published snapshot a live intake grew this one from, if any (same workflows, fewer conversations)."""
    try:
        row = db.private().execute("SELECT base_snapshot_id FROM intake_batches WHERE ingested_snapshot_id = ?",
                                   (snapshot["snapshot_id"],)).fetchone()
    except sqlite3.Error:
        return None
    if not row or not row["base_snapshot_id"]:
        return None
    raw = db.public().execute("SELECT json FROM snapshots WHERE snapshot_id = ?", (row["base_snapshot_id"],)).fetchone()
    if not raw:
        return None
    base = json.loads(raw["json"])
    if {c["id"] for c in base["clusters"]} != {c["id"] for c in snapshot["clusters"]}:
        return None
    if int(snapshot["totals"]["conversations"]) <= int(base["totals"]["conversations"]):
        return None
    return base


def change_data(snapshot: dict, base: dict) -> dict:
    """Before → after per workflow, from the two published snapshots (never from the model)."""
    before = {c["id"]: c for c in base["clusters"]}
    items = []
    for c in rankable(snapshot["clusters"]):
        o = before.get(c["id"])
        if o is None:
            continue
        items.append({"id": c["id"], "title": _short(c), "before": int(o["conversations"]), "after": int(c["conversations"]),
                      "friction_share_before": _fr(o).get("share"), "friction_share_after": _fr(c).get("share")})
    items.sort(key=lambda d: (-(d["after"] - d["before"]), -d["after"], d["id"]))
    bt, at = int(base["totals"]["conversations"]), int(snapshot["totals"]["conversations"])
    return {"base_snapshot_id": base["snapshot_id"], "conversations_before": bt, "conversations_after": at,
            "added_conversations": at - bt, "friction_share_before": _fr(base["totals"]).get("share"),
            "friction_share_after": _fr(snapshot["totals"]).get("share"), "items": items[:TOP_N]}


def change_values(snapshot: dict, base: dict | None) -> dict[str, str]:
    if base is None:
        return {}
    d = change_data(snapshot, base)
    vals = {"new_conversations": f"{d['added_conversations']:,}", "friction_share_before": _pct(d["friction_share_before"])}
    if d["items"] and d["items"][0]["after"] > d["items"][0]["before"]:
        vals["fastest_growing"] = d["items"][0]["title"]
    return vals


PH_MEANING = {
    "conversations": "conversations in the published map", "people": "distinct people",
    "languages": "languages seen", "friction_share": "share of all conversations with a friction signal",
    "top_workflow": "short title of the largest workflow", "top_workflow_share": "its share of all conversations",
    "hotspot": "short title of the workflow with the most conversations showing friction",
    "hotspot_friction_share": "friction share inside that workflow",
    "new_conversations": "conversations added by the latest batch", "fastest_growing": "short title of the workflow that grew most",
    "friction_share_before": "overall friction share before the latest batch",
}


def facts(snapshot: dict, base: dict | None = None) -> dict:
    """The compact facts sheet GLM sees: published aggregates and texts only, numbers rounded for reasoning."""
    t, ds, ws = snapshot["totals"], snapshot["dataset"], snapshot["workspace"]
    cats = {c["id"]: c for c in snapshot["categories"]}
    gv = global_values(snapshot)
    total = max(1, int(t["conversations"]))
    real = [c for c in snapshot["categories"] if not c.get("is_other")]
    size_rank = {c["id"]: i for i, c in enumerate(sorted(real, key=lambda c: -int(c["conversations"])), 1)}
    fric_rank = {c["id"]: i for i, c in enumerate(sorted(real, key=lambda c: -(_fr(c).get("share") or 0)), 1)}
    cat_of = lambda n: _short(cats[n["parent_id"]]) if n.get("parent_id") in cats else None  # noqa: E731
    sheet = {
        "dataset": {"name": ds["name"], "workspace": ws["name"], "about": ws.get("description", ""),
                    "period": f"{ds['period_start']} to {ds['period_end']}"},
        "placeholders": {k: f"{gv[k]}  ({PH_MEANING[k]})" for k in GLOBAL_PH if k in gv},
        "totals": {"conversations": gv["conversations"], "people": gv["people"], "languages": gv["languages"],
                   "friction_share": gv["friction_share"], "friction_conversations": f"{_fconv(t):,}"},
        "signals": {SIGNAL_LABELS[s]: f"{int((_fr(t).get('signals') or {}).get(s, 0)):,} conversations" for s in SIGNALS},
        "categories": [{"title": _short(c), "share": _pct(c.get("share")), "friction_share": _pct(_fr(c).get("share")),
                        "size_rank": f"{size_rank[c['id']]} of {len(real)}" if c["id"] in size_rank else "Other or unclear",
                        "friction_rank": f"{fric_rank[c['id']]} of {len(real)}" if c["id"] in fric_rank else "Other or unclear"}
                       for c in snapshot["categories"]],
        "languages": [{"name": x["name"], "share": _pct(int(x["conversations"]) / total)} for x in t.get("languages") or []],
        "largest_workflows": [f"{_short(c)} ({_pct(c.get('share'))} of conversations)" for c in _by_conversations(snapshot)[:TOP_N]],
        "highest_friction_share": [f"{_short(c)} ({_pct(_fr(c).get('share'))} of its {int(c['conversations']):,} conversations)"
                                   for c in sorted([c for c in rankable(snapshot["clusters"]) if int(c["conversations"]) >= MIN_RATE_BASE],
                                                   key=lambda c: (-(_fr(c).get("share") or 0), c["id"]))[:TOP_N]],
        "most_friction": [f"{_short(c)} ({_fconv(c):,} conversations with friction, {_pct(_fr(c).get('share'))} of its conversations)"
                          for c in _by_friction(snapshot)[:TOP_N]],
        "workflows": [{"id": c["id"], "short_title": _short(c), "title": c["title"], "category": cat_of(c),
                       "description": c.get("description", ""),
                       "needs": [x["text"] for x in (c.get("needs") or [])[:4]],
                       "problems": [x["text"] for x in (c.get("problems") or [])[:4]],
                       "conversations": f"{int(c['conversations']):,}", "share": _pct(c.get("share")),
                       "friction_share": _pct(_fr(c).get("share"))} for c in _by_conversations(snapshot)],
    }
    if base is not None:
        d, cv = change_data(snapshot, base), change_values(snapshot, base)
        sheet["placeholders"].update({k: f"{v}  ({PH_MEANING[k]})" for k, v in cv.items()})
        sheet["changes"] = {
            "what": "a new batch of conversations was just added to the previous published map",
            "conversations": f"{d['conversations_before']:,} before, {d['conversations_after']:,} now (+{d['added_conversations']:,})",
            "friction_share": f"{_pct(d['friction_share_before'])} before, {_pct(d['friction_share_after'])} now",
            "workflows_that_grew_most": [f"{x['title']}: {x['before']:,} to {x['after']:,} conversations, friction "
                                         f"{_pct(x['friction_share_before'])} to {_pct(x['friction_share_after'])}"
                                         for x in d["items"]],
        }
    return sheet


SYSTEM = (
    "You direct a one-minute product-analytics video about how people use a chat assistant. The audience is a "
    "product team. You write the storyboard: which scenes, in what order, how many seconds each, and the words on "
    "screen. Code renders every chart and every number from published aggregates; you only write words.\n"
    "VOICE: crisp, confident, specific. Every headline states an insight (what the data means, who struggles, where "
    "the product should act), never a label. Good: 'Coding help is where users fight the assistant', 'People come "
    "for answers, not conversation'. Bad: 'Friction overview', 'Top workflows', 'Language breakdown'. Name workflows "
    "by their short titles, contrast big versus painful, and ground every claim in the facts sheet. Never invent facts: "
    "a comparison (largest, small, highest friction, calm) must match the rankings given (categories, "
    "largest_workflows, most_friction, highest_friction_share). "
    "Each scene's headline must fit what that scene shows. Friction means a friction signal was observed (a "
    "correction, a repeated request, the assistant saying it can't help, or a complaint), not that the conversation "
    "failed: say 'hits friction', 'struggles' or 'pushes back', never 'fails' or 'broken'.\n"
    "SCENES (type: what the screen shows):\n"
    "- intro: title card over counters of conversations, people and languages. headline, optional kicker (subtitle).\n"
    "- change: ONLY when the facts sheet has 'changes' (a new batch of conversations just arrived); then it is "
    "REQUIRED and comes right after intro. Shows before-and-after bars for the workflows that grew most and the "
    "overall friction share before and now. Its headline says what the new data changed. With a change scene, drop "
    "languages or the second spotlight to stay within ten scenes. Placeholders {new_conversations}, "
    "{fastest_growing} and {friction_share_before} exist only then.\n"
    "- map: treemap of every category and its workflows, sized by share of conversations, coloured by friction.\n"
    "- top_workflows: ranked bars of the six largest workflows.\n"
    "- friction: ranked bars of the six workflows with the most conversations showing friction, against the overall "
    "friction share.\n"
    "- signals: the four friction signals as counts: corrected the assistant, asked again, assistant couldn't help, "
    "complained.\n"
    "- spotlight: close-up of ONE workflow (description, share, friction, signal mix, top problems and needs). Needs "
    "cluster_id (an id from the workflows list) and insight: what goes wrong there and why it matters, drawn from "
    "that workflow's problems. Pick telling workflows: large and painful, or with an unusually high friction share.\n"
    "- languages: the language split.\n"
    "- takeaways: exactly 3 bullets: what the product team should build or fix next, each tied to a named workflow "
    "or signal. Concrete verbs, no generic advice.\n"
    "- outro: a closing line that lands the main message.\n"
    "STRUCTURE: 6 to 10 scenes. First intro, last outro, takeaways directly before outro. map, friction and one or "
    "two spotlight scenes (different workflows) are required; every other type at most once.\n"
    "TIMING: seconds is an integer from 3 to 12 per scene and all seconds should add up to about 58 (code rescales "
    "other totals). A safe plan: intro 5, map 7, top_workflows 5, friction 7, signals 5, spotlight 7, "
    "spotlight 7, languages 4, takeaways 8, outro 4 (total 59); keep it unless you have a reason. If you drop a scene, give its seconds to the "
    "spotlights, map or takeaways.\n"
    "FIELDS AND LENGTHS (words, counted strictly): title 3-10; headline 2-10 on every scene; kicker only on intro, "
    "up to 12; cluster_id and insight only on spotlight, insight a single sentence of 12-28 words; bullets only on "
    "takeaways, exactly 3, each 6-14 words. Leave every other field out.\n"
    "NUMBERS: never write digits, the percent sign, or number words. Banned words: zero, one, two ... twenty, dozen, "
    "hundred, thousand, million, billion, half, twice, double, triple, quarter, third, percent, majority, most, "
    "minority (also inside compounds like one-off, and approximations like 'nearly half'). Instead of 'one' write "
    "'a' or 'a single'; instead of 'most' write 'the bulk of' or 'the largest'; for a share use a placeholder or a "
    "comparison ('far above the overall rate'). When a figure helps, write a placeholder exactly and code "
    "fills it from verified metrics: {conversations}, {people}, {languages}, {friction_share}, {top_workflow}, "
    "{top_workflow_share}, {hotspot}, {hotspot_friction_share} (their values are in the facts sheet); inside a "
    "spotlight scene also {share}, {friction_share_here}, {conversations_here}, {people_here} for that workflow. "
    "Curly braces only for these placeholders. Use them where a figure makes the line land: the intro kicker, the "
    "friction headline and each spotlight insight (cite {friction_share_here} or {share} there) are good places.\n"
    "No medical conditions, ages, cities, countries or other places, companies, contact details or links. Plain "
    "English, no markdown, no emoji, no quotation marks."
)

RETURN = ('\nReturn {"title": "...", "scenes": [{"type": "intro", "seconds": 5, "headline": "...", "kicker": "..."}, '
          '{"type": "map", "seconds": 7, "headline": "..."}, ..., {"type": "spotlight", "seconds": 7, "headline": "...", '
          '"cluster_id": "<copy an id exactly from the workflows list>", "insight": "..."}, ..., {"type": "takeaways", '
          '"seconds": 8, "headline": "...", "bullets": ["...", "...", "..."]}, {"type": "outro", "seconds": 4, '
          '"headline": "..."}]}. Before answering, check every cluster_id is copied '
          'exactly.')


# ---------------------------------------------------------------- the gate

def _clean(s: str | None) -> str:
    return " ".join(str(s or "").split())


def _text_problems(field: str, text: str, allowed: set[str], lo: int, hi: int) -> list[str]:
    probs: list[str] = []
    bare = PLACEHOLDER.sub("", text)
    words = len(text.split())
    if not (lo <= words <= hi):
        probs.append(f"{field}: must be {lo}-{hi} words")
    if re.search(r"\d", bare) or "%" in bare:
        probs.append(f"{field}: no digits or percent signs — use the placeholders")
    toks = set(re.findall(r"[a-z']+", bare.lower()))
    if toks & NUMBER_WORDS:
        probs.append(f"{field}: no number words (one, two, half, most, percent, ...) — use the placeholders")
    bad = sorted(set(PLACEHOLDER.findall(text)) - allowed)
    if bad:
        probs.append(f"{field}: placeholders not allowed here: " + ", ".join("{" + b + "}" for b in bad))
    if "{" in bare or "}" in bare:
        probs.append(f"{field}: braces are only for placeholders")
    low = f" {bare.lower()} "
    if toks & DIAGNOSES:
        probs.append(f"{field}: no medical conditions")
    if any(p in low for p in PLACES if " " in p) or toks & {p for p in PLACES if " " not in p}:
        probs.append(f"{field}: no cities, countries or exact places")
    if AGE_WORDS.search(bare):
        probs.append(f"{field}: no ages")
    return probs


def _scene_data(kind: str, node: dict | None, snapshot: dict) -> dict | None:
    """What each scene visualises, computed from the published snapshot (never from the model)."""
    t, ds = snapshot["totals"], snapshot["dataset"]
    cats = {c["id"]: c for c in snapshot["categories"]}
    leaf = lambda c: {"id": c["id"], "title": _short(c), "share": c.get("share"),  # noqa: E731
                      "conversations": int(c["conversations"]), "friction_share": _fr(c).get("share")}
    if kind == "map":
        kids: dict[str, list[dict]] = {}
        for c in snapshot["clusters"]:
            kids.setdefault(c.get("parent_id"), []).append(c)
        return {"categories": [{**leaf(c), "is_other": bool(c.get("is_other")),
                                "children": [leaf(k) for k in sorted(kids.get(c["id"], []),
                                                                     key=lambda k: (-int(k["conversations"]), k["id"]))]}
                               for c in snapshot["categories"]]}
    if kind == "top_workflows":
        return {"items": [{"id": c["id"], "title": _short(c), "category": _short(cats[c["parent_id"]]) if c.get("parent_id") in cats else "",
                           "share": c.get("share"), "conversations": int(c["conversations"]), "people": int(c.get("users") or 0)}
                          for c in _by_conversations(snapshot)[:TOP_N]]}
    if kind == "friction":
        return {"overall_share": _fr(t).get("share"),
                "items": [{"id": c["id"], "title": _short(c), "friction_share": _fr(c).get("share"),
                           "friction_conversations": _fconv(c), "conversations": int(c["conversations"])}
                          for c in _by_friction(snapshot)[:TOP_N]]}
    if kind == "signals":
        sig = _fr(t).get("signals") or {}
        items = [{"signal": s, "label": SIGNAL_LABELS[s], "conversations": int(sig.get(s, 0))} for s in SIGNALS]
        return {"friction_conversations": _fconv(t), "items": sorted(items, key=lambda x: -x["conversations"])}
    if kind == "spotlight" and node is not None:
        sig = _fr(node).get("signals") or {}
        return {"id": node["id"], "title": node["title"],
                "category": _short(cats[node["parent_id"]]) if node.get("parent_id") in cats else "",
                "description": node.get("description", ""), "share": node.get("share"),
                "conversations": int(node["conversations"]), "people": int(node.get("users") or 0),
                "friction_share": _fr(node).get("share"), "signals": {s: int(sig.get(s, 0)) for s in SIGNALS},
                "problems": [x["text"] for x in (node.get("problems") or [])[:4]],
                "needs": [x["text"] for x in (node.get("needs") or [])[:4]]}
    if kind == "languages":
        total = max(1, int(t["conversations"]))
        return {"languages": int(ds["languages"]),
                "items": [{"name": x["name"], "conversations": int(x["conversations"]),
                           "share": round(int(x["conversations"]) / total, 4)} for x in t.get("languages") or []]}
    if kind == "outro":
        return {"snapshot_id": snapshot["snapshot_id"], "pipeline": PIPELINE}
    return None


def normalize_seconds(proposed: list[int], target: int = 58) -> list[int]:
    """Clamp each scene to MIN_SEC-MAX_SEC and, if the total is out of range, rescale to `target`."""
    secs = [min(MAX_SEC, max(MIN_SEC, x)) for x in proposed]
    total = sum(secs)
    if MIN_TOTAL <= total <= MAX_TOTAL:
        return secs
    secs = [min(MAX_SEC, max(MIN_SEC, round(x * target / total))) for x in secs]
    order = sorted(range(len(secs)), key=lambda k: -secs[k])
    for i in range(20 * len(secs)):
        diff = target - sum(secs)
        if diff == 0:
            break
        k = order[i % len(order)]
        if diff > 0 and secs[k] < MAX_SEC:
            secs[k] += 1
        elif diff < 0 and secs[k] > MIN_SEC:
            secs[k] -= 1
    return secs


def validate(out: _BriefOut, snapshot: dict, base: dict | None = None) -> tuple[list[str], dict]:
    """Returns (problems, filled). Problem strings are ours (fixed vocabulary); `filled` is empty on failure."""
    probs: list[str] = []
    scenes = out.scenes
    types = [_clean(s.type).lower() for s in scenes]
    n = len(types)
    if not (MIN_SCENES <= n <= MAX_SCENES):
        probs.append(f"use {MIN_SCENES}-{MAX_SCENES} scenes")
    if any(t not in TYPES for t in types):
        probs.append("scene type must be one of: " + ", ".join(TYPES))
    if not types or types[0] != "intro":
        probs.append("the first scene must be intro")
    if not types or types[-1] != "outro":
        probs.append("the last scene must be outro")
    if types.count("takeaways") != 1 or n < 2 or types[-2] != "takeaways":
        probs.append("takeaways must appear exactly once, directly before outro")
    for t in TYPES:
        if t != "spotlight" and types.count(t) > 1:
            probs.append(f"{t} may appear only once")
    for t in ("map", "friction"):
        if t not in types:
            probs.append(f"a {t} scene is required")
    if base is None and "change" in types:
        probs.append("a change scene is only allowed when the facts sheet has changes")
    if base is not None and (n < 2 or types[1] != "change"):
        probs.append("new data arrived: a change scene is required right after intro")
    pool = {c["id"]: c for c in rankable(snapshot["clusters"])}
    spots = [s for s, t in zip(scenes, types) if t == "spotlight"]
    if not (1 <= len(spots) <= 2):
        probs.append("use one or two spotlight scenes")
    ids = [_clean(s.cluster_id) for s in spots]
    if len(set(ids)) != len(ids):
        probs.append("spotlight scenes must feature different workflows")
    for i, cid in enumerate(ids, 1):
        if cid not in pool:
            probs.append(f"spotlight {i}: cluster_id must be a workflow id from the workflows list")
    # Pacing is not a fact, so the model's timings are normalised by code rather than rejected.
    proposed = [int(s.seconds) for s in scenes]
    secs = normalize_seconds(proposed) if MIN_SCENES <= n <= MAX_SCENES else proposed
    total = sum(secs)

    gv = {**global_values(snapshot), **change_values(snapshot, base)}
    allowed_base = {k for k in (*GLOBAL_PH, *CHANGE_PH) if k in gv}
    title = _clean(out.title)
    probs += _text_problems("title", title, allowed_base, 3, 10)
    texts: list[tuple[int, str, str]] = []   # (scene index, field, raw text) for filling
    for i, (s, t) in enumerate(zip(scenes, types), 1):
        allowed = allowed_base | (set(SPOT_PH) if t == "spotlight" else set())
        where = f"scene {i} ({t if t in TYPES else 'unknown'})"
        head = _clean(s.headline)
        probs += _text_problems(f"{where} headline", head, allowed, 2, 10)
        if t == "intro" and _clean(s.kicker):
            probs += _text_problems(f"{where} kicker", _clean(s.kicker), allowed, 1, 12)
        if t == "spotlight":
            probs += _text_problems(f"{where} insight", _clean(s.insight), allowed, 3, 30)
        if t == "takeaways":
            bullets = [_clean(b) for b in s.bullets or []]
            if len(bullets) != 3:
                probs.append(f"{where}: exactly 3 bullets")
            for j, b in enumerate(bullets, 1):
                probs += _text_problems(f"{where} bullet {j}", b, allowed, 3, 14)
    if probs:
        return list(dict.fromkeys(probs)), {}

    used: dict[str, str] = {}       # metrics_used name -> value, first appearance order
    counts = {"numbers": 0, "names": 0}

    def fill(text: str, node: dict | None) -> str:
        vals = {**gv, **(spot_values(node) if node is not None else {})}

        def one(m: re.Match) -> str:
            name = m.group(1)
            counts["names" if name in NAME_PH else "numbers"] += 1
            used[f"{name} · {_short(node)}" if name in SPOT_PH and node is not None else name] = vals[name]
            return vals[name]
        return PLACEHOLDER.sub(one, text)

    filled_title = fill(title, None)
    frame = 0
    out_scenes: list[dict] = []
    for s, t in zip(scenes, types):
        node = pool.get(_clean(s.cluster_id)) if t == "spotlight" else None
        sec = secs[len(out_scenes)]
        sc: dict = {"type": t, "seconds": sec, "from_frame": frame, "frames": sec * FPS,
                    "headline": fill(_clean(s.headline), node)}
        frame += sec * FPS
        if t == "intro" and _clean(s.kicker):
            sc["kicker"] = fill(_clean(s.kicker), node)
        if t == "spotlight":
            sc["cluster_id"] = node["id"]   # type: ignore[index]
            sc["insight"] = fill(_clean(s.insight), node)
        if t == "takeaways":
            sc["bullets"] = [fill(_clean(b), node) for b in s.bullets or []]
        data = change_data(snapshot, base) if t == "change" and base is not None else _scene_data(t, node, snapshot)
        if data is not None:
            sc["data"] = data
        out_scenes.append(sc)
    flat = " ".join([filled_title] + [x for sc in out_scenes
                                      for x in [sc["headline"], sc.get("kicker", ""), sc.get("insight", ""), *sc.get("bullets", [])]])
    if leakcheck.problems(flat):
        return ["no contact details, links or identifiers"], {}
    spot_titles = [_short(pool[c]) for c in ids]
    checks = [
        f"{n} scenes, {total} s ({frame} frames at {FPS} fps)"
        + ("" if secs == proposed else f"; pacing normalised by code from the model's {sum(proposed)} s"),
        f"{counts['numbers']} numbers" + (f" and {counts['names']} workflow name{'s' if counts['names'] > 1 else ''}" if counts["names"] else "")
        + " filled from published metrics",
        "0 digits or number words written by the model",
        "spotlight " + " and ".join(spot_titles) + (" exist and are rankable" if len(spot_titles) > 1 else " exists and is rankable"),
        "scene order, durations and text lengths within limits",
        "no medical conditions, places, ages, contact details or canary tokens",
        "every chart's data attached by code from the published snapshot",
    ]
    if base is not None:
        checks.append(f"change scene compares against the previous published snapshot {base['snapshot_id']}")
    return [], {"title": filled_title, "scenes": out_scenes, "duration_frames": frame,
                "metrics_used": [{"name": k, "value": v} for k, v in used.items()], "checks": checks}


def assemble(filled: dict, snapshot: dict, *, model: str, attempts: int) -> dict:
    t, ds = snapshot["totals"], snapshot["dataset"]
    return {
        "brief_id": brief_id(), "snapshot_id": snapshot["snapshot_id"], "generated_at": utcnow(), "model": model,
        "label": LABEL, "fps": FPS, "width": WIDTH, "height": HEIGHT, "duration_frames": filled["duration_frames"],
        "title": filled["title"],
        "dataset": {"name": ds["name"], "workspace": snapshot["workspace"]["name"],
                    "period_start": ds["period_start"], "period_end": ds["period_end"]},
        "totals": {"conversations": int(t["conversations"]), "people": int(t["users"]), "languages": int(ds["languages"]),
                   "friction_share": _fr(t).get("share"), "friction_conversations": _fconv(t),
                   "unclear": int(_fr(t).get("unclear") or 0)},
        "scenes": filled["scenes"], "metrics_used": filled["metrics_used"], "checks": filled["checks"],
        "attempts": attempts, "video_url": None,
    }


# ---------------------------------------------------------------- storage and run

def latest(snapshot_id: str) -> dict | None:
    row = db.public().execute("SELECT json FROM briefs WHERE snapshot_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                              (snapshot_id,)).fetchone()
    return json.loads(row["json"]) if row else None


def _save(brief: dict) -> None:
    con = db.public()
    with db.write(con):
        con.execute("INSERT INTO briefs(brief_id, snapshot_id, json, created_at) VALUES (?,?,?,?)",
                    (brief["brief_id"], brief["snapshot_id"], json.dumps(brief), brief["generated_at"]))


def user_prompt(snapshot: dict, base: dict | None = None) -> str:
    return ("Facts sheet (published aggregates only; the figures are for your judgement, never to be written):\n"
            + json.dumps(facts(snapshot, base), ensure_ascii=False, separators=(",", ":")) + RETURN)


def direct(prompt: str) -> tuple[_BriefOut | None, dict]:
    try:
        return glm.chat_json(SYSTEM, prompt, _BriefOut, reasoning="low", temperature=0.5, max_tokens=3000,
                             use_cache=False, retries=0, timeout=60.0, attempts=1)
    except glm.GLMOutputError:
        return None, {}


def run_brief(run: Run, *, snapshot: dict) -> None:
    try:
        _run(run, snapshot)
    except ProviderError as e:
        run.fail("model_unavailable", f"The video director model is unavailable ({e.provider}).")
    except Exception as e:  # noqa: BLE001
        log.error("brief %s crashed: %s", run.id, type(e).__name__)
        run.fail("internal_error", "The video brief could not be directed.")


def _run(run: Run, snapshot: dict) -> None:
    run.state("planning")
    run.stage("reading", "running", "facts sheet from the published map (aggregates only, no conversations)")
    base = baseline(snapshot)
    user = user_prompt(snapshot, base)
    run.stage("reading", "done", f"{len(rankable(snapshot['clusters']))} workflows, "
                                 f"{len(snapshot['categories'])} categories, no conversation text"
              + (f"; compared with the previous map ({int(snapshot['totals']['conversations']) - int(base['totals']['conversations']):,} new conversations)"
                 if base is not None else ""))
    problems: list[str] = []
    for attempt in (1, 2):
        if attempt == 2:
            run.insert_stages(["directing", "checking"])   # one repair round, same stage names
        run.state("planning")
        run.stage("directing", "running", "GLM 5.3 storyboards scenes, timing and on-screen words" if attempt == 1
                  else "one repair attempt with the gate's feedback")
        prompt = user if attempt == 1 else (user + "\nYour previous storyboard was rejected: " + "; ".join(problems)[:1500]
                                            + ". Write a new one that fixes every point.")
        out, meta = direct(prompt)
        run.stage("directing", "done" if out else "failed",
                  f"{meta.get('model', glm.GLM)} returned {len(out.scenes)} scenes" if out else "no valid JSON from the model")
        run.state("validating")
        run.stage("checking", "running", "scene order, durations, ids, placeholders, no numbers, privacy and leak checks")
        if out is None:
            problems, filled = ["return valid JSON matching the schema"], {}
        else:
            problems, filled = validate(out, snapshot, base)
        if not problems:
            brief = assemble(filled, snapshot, model=meta.get("model", glm.GLM), attempts=attempt)
            _save(brief)
            from . import brief_video   # MP4 export starts now; the player needs nothing more
            brief_video.ensure(brief)
            run.stage("checking", "done", "passed: " + "; ".join(filled["checks"][:3]))
            run.complete()
            return
        run.stage("checking", "failed", "rejected: " + "; ".join(problems)[:300])
    run.fail("brief_rejected", "The video storyboard did not pass the gate after one repair attempt, so it is not shown.")
