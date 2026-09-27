"""Surprising workflows: one Jev call scores every published leaf against the workspace's intended
uses (Choice covered / partly_covered / not_covered). `surprising.score` = P(not covered); leaves at
or above the threshold are flagged. Runs on gated (final) text."""
from __future__ import annotations

import logging

from ..config_workspace import INTENDED_USES, SURPRISING_THRESHOLD
from . import util
from .questions import surprise_questions

log = logging.getLogger("logless.pipeline.surprising")


def run(build: util.Build) -> dict:
    st = build.load("structure_final")
    leaves = [lf for lf in st["leaves"] if not lf["is_other"]]
    keys = {f"w{i + 1}": lf for i, lf in enumerate(leaves)}
    state = {"intended_uses": INTENDED_USES,
             "workflows": {k: {"title": lf["title"], "description": lf["description_pub"]} for k, lf in keys.items()}}
    ans = util.jev_ask(state, surprise_questions(list(keys)))
    for k, lf in keys.items():
        probs = ans[k].get("probabilities") or {}
        score = round(float(probs.get("not_covered", 0.0)), 4)
        lf["surprising"] = {"flag": score >= SURPRISING_THRESHOLD, "score": score}
    build.save("structure_final", st)
    flagged = sum(1 for lf in leaves if lf["surprising"]["flag"])
    return {"leaves_scored": len(leaves), "flagged": flagged}
