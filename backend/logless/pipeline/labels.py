"""Stage `labels` (after the gate) — short map labels: `short_title` (1–3 words, <= 22 characters,
goal-flavoured, unique across all nodes) for every leaf and category. One GLM-5.3 call (reasoning
off) sees all nodes so labels are mutually distinct; the result is validated (length, words,
uniqueness, no numbers) with one repair call, and every label passes the same deterministic privacy
checks and Jev identifiability signal as other published text. Node ids never change. GLM calls are
cached (llm_cache), so re-running the stage on the same build reproduces the same labels."""
from __future__ import annotations

import json
import logging
import re

from .. import db
from ..config import GLM
from ..data import fixtures
from . import util
from .describe import has_number
from .gate import IDENT_MAX, deterministic, jev_ident
from .privacy import TokenScanner
from .prompts import LABELS_SYS, ShortLabels

log = logging.getLogger("logless.pipeline.labels")

MAX_WORDS, MAX_CHARS = 3, 22
OTHER_LEAF_LABEL = "Other or unclear"
OTHER_CAT_LABEL = "Other"
LABEL_RE = re.compile(r"^[\w][\w&' \-]*$", re.U)


def label_problems(label: str) -> list[str]:
    """Shape rules for one label (uniqueness is checked across the set)."""
    p = []
    t = label.strip()
    if not t:
        return ["empty"]
    if len(t) > MAX_CHARS:
        p.append(f"longer than {MAX_CHARS} characters")
    if len(t.split()) > MAX_WORDS:
        p.append(f"more than {MAX_WORDS} words")
    if has_number(t) or re.search(r"\d", t):
        p.append("contains a number")
    if not LABEL_RE.match(t):
        p.append("contains punctuation other than hyphens, ampersands or apostrophes")
    return p


def validate_labels(labels: dict[str, str], keys: list[str]) -> dict[str, list[str]]:
    """Problems per key: missing, shape, duplicates (case-insensitive) across all nodes."""
    out: dict[str, list[str]] = {k: [] for k in keys}
    seen: dict[str, str] = {}
    for k in keys:
        lab = (labels.get(k) or "").strip()
        if not lab:
            out[k].append("missing")
            continue
        out[k] += label_problems(lab)
        norm = lab.casefold()
        if norm in seen:
            out[k].append(f"duplicates another node's label")
            out[seen[norm]].append("duplicates another node's label")
        else:
            seen[norm] = k
    return {k: v for k, v in out.items() if v}


def _fallback(title: str, used: set[str]) -> str:
    """Deterministic label from the (already gated) title: its first words, clipped to the limits."""
    words = [w for w in re.findall(r"[\w&'\-]+", title) if not re.search(r"\d", w)]
    for n in (3, 2, 1):
        cand = " ".join(words[:n])
        if cand and len(cand) <= MAX_CHARS and cand.casefold() not in used:
            return cand
    base = (words[0] if words else "Requests")[:MAX_CHARS - 3]
    i = 2
    while f"{base} {chr(64 + i)}".casefold() in used:
        i += 1
    return f"{base} {chr(64 + i)}"


def run(build: util.Build) -> dict:
    st = build.load("structure_final")
    leaves, cats = st["leaves"], st["categories"]
    cat_label = {}
    nodes = []  # (key, node dict, level)
    for c in cats:
        if not c.get("is_other"):
            nodes.append((c["id"], c, 1))
    for lf in leaves:
        if not lf["is_other"]:
            nodes.append((lf["id"], lf, 2))
    keys = [k for k, _, _ in nodes]
    fixed = {c["id"]: OTHER_CAT_LABEL for c in cats if c.get("is_other")}
    fixed.update({lf["id"]: OTHER_LEAF_LABEL for lf in leaves if lf["is_other"]})

    def payload() -> str:
        docs = []
        for k, n, level in nodes:
            d = {"key": k, "level": "category" if level == 1 else "leaf",
                 "title": n.get("title_pub") if level == 1 else n["title"],
                 "description": n.get("description_pub", "")}
            if level == 2:
                d["category_key"] = n["parent_id"]
            docs.append(d)
        return ("Write one short_title for each of these " + str(len(docs)) + " nodes:\n" +
                json.dumps({"nodes": docs, "reserved_labels": sorted(fixed.values())}, ensure_ascii=False, indent=1))

    user = payload()
    labels: dict[str, str] = {}
    glm_failed = 0
    try:
        out = util.glm_json(LABELS_SYS, user, ShortLabels, model=GLM, reasoning="off", temperature=0.2, max_tokens=3000)
        labels = {x.key: x.short_title.strip() for x in out.items if x.key in keys}
    except Exception as e:  # missing labels are repaired below, then fall back to deterministic ones
        glm_failed = 1
        log.warning("labels: GLM call failed (%s)", type(e).__name__)
    probs = validate_labels({**labels, **fixed}, keys + list(fixed))
    repaired = 0
    if probs:
        fix = user + "\n\nYour previous labels were:\n" + json.dumps(labels, ensure_ascii=False) + \
              "\n\nFix these (keep every other label unchanged): " + json.dumps(probs, ensure_ascii=False)
        try:
            out2 = util.glm_json(LABELS_SYS, fix, ShortLabels, model=GLM, reasoning="off", temperature=0.2, max_tokens=3000)
            new = {x.key: x.short_title.strip() for x in out2.items if x.key in keys}
            for k in probs:
                if k in new:
                    labels[k] = new[k]
                    repaired += 1
        except Exception as e:
            log.warning("labels repair failed (%s)", type(e).__name__)

    # privacy: the same deterministic checks + Jev identifiability as other published text
    scanner = TokenScanner(fixtures.load_tokens())
    corpus = [r["text"] for r in util.load_rows(build.conv_ids, "SELECT conv_id, text FROM conversations WHERE conv_id IN ({})").values()]

    def privacy_fail(cands: dict[str, str]) -> set[str]:
        items = [{"key": k, "node": k, "role": "short_title", "text": v} for k, v in cands.items()]
        det = deterministic(items, scanner, corpus)
        ident = jev_ident(items)
        return {k for k in cands if det.get(k) or k not in ident or ident[k] >= IDENT_MAX}

    flagged = privacy_fail({k: labels.get(k, "") for k in keys if labels.get(k)})
    fallback = 0
    for _ in range(2):
        bad = set(validate_labels({**labels, **fixed}, keys + list(fixed))) | flagged
        bad -= set(fixed)
        if not bad:
            break
        used = {v.casefold() for k, v in {**labels, **fixed}.items() if k not in bad}
        for k in sorted(bad):
            n = next(n for kk, n, lv in nodes if kk == k)
            labels[k] = _fallback(n.get("title_pub") or n["title"], used)
            used.add(labels[k].casefold())
            fallback += 1
        flagged = privacy_fail({k: labels[k] for k in bad})
    remaining = set(validate_labels({**labels, **fixed}, keys + list(fixed))) | flagged
    if remaining:
        raise RuntimeError(f"labels: {len(remaining)} short titles still fail validation or privacy checks")
    final = {**labels, **fixed}
    for c in cats:
        c["short_title"] = final[c["id"]]
    for lf in leaves:
        lf["short_title"] = final[lf["id"]]
    build.save("structure_final", st)
    build.save("labels", {"labels": final, "repaired": repaired, "fallback": fallback})
    return {"nodes": len(final), "repaired": repaired, "fallback": fallback, "privacy_flagged": len(flagged),
            "glm_failed": glm_failed}
