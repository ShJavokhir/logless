"""Allowlist serializers: every browser payload is built field by field from stored records.

Nothing is passed through wholesale. A field that is not named here cannot reach a browser, so
extra private-looking fields in a stored record (conv_id, user_id, text, stderr_tail, …) are
dropped by construction. Ids are checked against their public formats, and the output is
validated against the pydantic mirror of the TypeScript contract."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..sandbox.plan import sanitize_question
from . import leakcheck, models

log = logging.getLogger("logless.api")
SIGNALS = ("correction", "repeat_request", "assistant_limit", "complaint")
CARE = ("refusal", "sensitive")

SNAPSHOT_ID = re.compile(r"^snap_\d{8}T\d{6}_[0-9a-f]{4}$")
CATEGORY_ID = re.compile(r"^cat_[0-9a-f]{6}$")
LEAF_ID = re.compile(r"^cl_(?:[0-9a-f]{6}|other)$")
EVIDENCE_ID = re.compile(r"^[np][1-9]\d{0,2}$")
RUN_ID = re.compile(r"^run_[0-9a-f]{12}$")
MAP_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
PLACEHOLDER_KEY = re.compile(r"^(?:total_count|total_base|rows\.\d{1,2}\.(?:id|count|base|share))$")


class Blocked(RuntimeError):
    """A payload failed an allowlist or leak check and must not be served."""


def _int(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or v < 0:
        raise Blocked("bad integer")
    return int(v)


def _num(v: Any) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise Blocked("bad number")
    return float(v)


def _share(v: Any) -> float:
    return round(_num(v), 4)


def _str(v: Any, limit: int) -> str:
    if not isinstance(v, str):
        raise Blocked("bad string")
    return v[:limit]


def _opt_str(v: Any, limit: int) -> str | None:
    return None if v is None else _str(v, limit)


def _id(v: Any, pattern: re.Pattern) -> str:
    if not isinstance(v, str) or not pattern.match(v):
        raise Blocked("bad id")
    return v


def _node_id(v: Any) -> str:
    if isinstance(v, str) and (CATEGORY_ID.match(v) or LEAF_ID.match(v)):
        return v
    raise Blocked("bad id")


def _group_id(v: Any) -> str:
    """A question result row: a category, leaf or sub-theme id."""
    if isinstance(v, str) and SUBTHEME_ID.match(v):
        return v
    return _node_id(v)


# ---------------------------------------------------------------- snapshot

def _metrics(m: dict) -> dict:
    f = m["friction"]
    return {
        "conversations": _int(m["conversations"]),
        "users": _int(m["users"]),
        "share": _share(m["share"]),
        "friction": {
            "conversations": _int(f["conversations"]),
            "share": None if f.get("share") is None else _share(f["share"]),
            "unclear": _int(f["unclear"]),
            "signals": {s: _int(f["signals"][s]) for s in SIGNALS},
        },
        "languages": [{"name": _str(x["name"], 60), "conversations": _int(x["conversations"])} for x in (m.get("languages") or [])][:6],
        **({"care": {k: _int(m["care"][k]) for k in (*CARE, "unclear")}} if isinstance(m.get("care"), dict) else {}),
        **({"concentration": {k: None if m["concentration"].get(k) is None else round(_num(m["concentration"][k]), 4)
                              for k in ("top_people_share", "conversations_per_person")}}
           if isinstance(m.get("concentration"), dict) else {}),
    }


SHORT_TITLE_MAX = 24


def short_title(raw: Any, title: str) -> str:
    """The published short_title (≤ 24 chars), or the title shortened at a word boundary."""
    text = " ".join(raw.split()) if isinstance(raw, str) and raw.strip() else " ".join(title.split())
    if len(text) <= SHORT_TITLE_MAX:
        return text
    cut = text[: SHORT_TITLE_MAX - 1]
    if " " in cut[8:]:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-–—") + "…"


def _node(n: dict, level: int) -> dict:
    out = _metrics(n)
    out["id"] = _id(n["id"], CATEGORY_ID if level == 1 else LEAF_ID)
    out["level"] = level
    out["parent_id"] = None if level == 1 else _id(n["parent_id"], CATEGORY_ID)
    out["title"] = _str(n["title"], 120)
    out["short_title"] = short_title(n.get("short_title"), out["title"])
    out["description"] = _str(n["description"], 600)
    if level == 1:
        out["children"] = [_id(c, LEAF_ID) for c in n.get("children") or []]
    else:
        out["needs"] = [{"id": _id(x["id"], EVIDENCE_ID), "text": _str(x["text"], 300)} for x in n.get("needs") or []]
        out["problems"] = [{
            "id": _id(x["id"], EVIDENCE_ID), "text": _str(x["text"], 300),
            "signal": x.get("signal") if x.get("signal") in SIGNALS else None,
            "support": "common" if x.get("support") == "common" else "observed",
        } for x in n.get("problems") or []]
        if isinstance(n.get("surprising"), dict):
            out["surprising"] = {"flag": bool(n["surprising"].get("flag")), "score": _num(n["surprising"].get("score", 0))}
    if "is_other" in n:
        out["is_other"] = bool(n["is_other"])
    return out


def serialize_snapshot(raw: dict) -> dict:
    ds, prov, ws = raw["dataset"], raw["provenance"], raw["workspace"]
    out = {
        "snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID),
        "created_at": _str(raw["created_at"], 40),
        "workspace": {"name": _str(ws["name"], 120), "description": _str(ws["description"], 600)},
        "dataset": {
            "name": _str(ds["name"], 60), "source_url": _str(ds["source_url"], 200), "revision": _str(ds["revision"], 64),
            "license": _str(ds["license"], 40), "attribution": _str(ds["attribution"], 400),
            "period_start": _str(ds["period_start"], 10), "period_end": _str(ds["period_end"], 10),
            "conversations": _int(ds["conversations"]), "users": _int(ds["users"]), "languages": _int(ds["languages"]),
            "sample_note": _str(ds["sample_note"], 600),
            "fixtures": {"canary_conversations": _int(ds["fixtures"]["canary_conversations"]),
                         "injection_conversations": _int(ds["fixtures"].get("injection_conversations", 0))},
        },
        "totals": _metrics(raw["totals"]),
        "categories": [_node(n, 1) for n in raw["categories"]],
        "clusters": [_node(n, 2) for n in raw["clusters"]],
        "intended_uses": [_str(x, 120) for x in raw.get("intended_uses") or []],
        "provenance": {
            "pipeline_version": _str(prov["pipeline_version"], 40), "dataset_hash": _str(prov["dataset_hash"], 80),
            # Free-form maps: only simple keys with string values survive; the leak check below still
            # blocks the whole payload if any value carries a private id or canary.
            "models": {k: _str(v, 80) for k, v in (prov.get("models") or {}).items() if MAP_KEY.match(str(k)) and isinstance(v, str)},
            "prompt_versions": {k: _str(v, 40) for k, v in (prov.get("prompt_versions") or {}).items() if MAP_KEY.match(str(k)) and isinstance(v, str)},
            "discovery_rounds": _int(prov.get("discovery_rounds", 0)), "build_seconds": _num(prov.get("build_seconds", 0)),
            "stages": [{
                "stage": _str(s["stage"], 60), "started_at": _str(s["started_at"], 40), "finished_at": _str(s["finished_at"], 40),
                "counts": {k: _int(v) for k, v in (s.get("counts") or {}).items()
                           if MAP_KEY.match(str(k)) and isinstance(v, int) and not isinstance(v, bool)},
                "models": [_str(x, 80) for x in s.get("models") or []],
            } for s in prov.get("stages") or []],
        },
    }
    models.Snapshot.model_validate(out)
    # Canary tokens and private ids must never appear anywhere; contact patterns are checked on
    # the free-text fields only (the dataset block legitimately carries a URL and dates).
    if leakcheck.problems(json.dumps(out, ensure_ascii=False), contact=False):
        raise Blocked("snapshot failed the leak check")
    for n in out["categories"] + out["clusters"]:
        texts = [n["title"], n["short_title"], n["description"]] + [x["text"] for x in n.get("needs", []) + n.get("problems", [])]
        found = {p for t in texts for p in leakcheck.problems(t)}
        if "canary token" in found:
            raise Blocked("snapshot text failed the canary check")
        if found:
            log.warning("snapshot text field matched a contact pattern (node %s)", n["id"])
    return out


# ---------------------------------------------------------------- runs

JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP = re.compile(r"^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)?$")
LABEL = re.compile(r"^[a-z0-9][a-z0-9._:/@-]{0,159}$")


def _receipt(r: dict | None) -> dict | None:
    """Receipts pass through strict patterns: they describe a machine we trust less."""
    if not r:
        return None
    lim = r["limits"]
    if r.get("runtime") not in ("runsc", "runc"):
        raise Blocked("bad runtime")
    ec = r.get("exit_code")
    if ec is not None and (isinstance(ec, bool) or not isinstance(ec, int) or not -512 <= ec <= 512):
        raise Blocked("bad exit code")
    return {
        "job_id": _id(r["job_id"], JOB_ID), "runtime": r["runtime"], "image": _id(r["image"], LABEL),
        "code_sha256": _id(r["code_sha256"], SHA256),
        "exit_code": ec,
        "elapsed_ms": _int(r["elapsed_ms"]), "timed_out": bool(r["timed_out"]), "output_bytes": _int(r["output_bytes"]),
        "container_removed": bool(r["container_removed"]),
        "limits": {"cpus": _num(lim["cpus"]), "memory_mb": _int(lim["memory_mb"]), "pids": _int(lim["pids"]),
                   "timeout_s": _num(lim["timeout_s"]), "network": "none", "read_only_root": True},
        "started_at": _id(r["started_at"], TIMESTAMP), "finished_at": _id(r["finished_at"], TIMESTAMP),
        "host": _id(r["host"], LABEL),
    }


def _verdict(v: dict | None) -> dict | None:
    if not v:
        return None
    return {"passed": bool(v["passed"]),
            "checks": [{"name": _str(c["name"], 80), "passed": bool(c["passed"]), "detail": _str(c["detail"], 400)} for c in v["checks"]][:60]}


def _result(res: dict | None) -> dict | None:
    if not res:
        return None
    if res.get("intent") != "question":
        raise Blocked("bad result intent")
    return {"intent": "question", "snapshot_id": _id(res["snapshot_id"], SNAPSHOT_ID), "plan": _plan(res["plan"]),
            "rows": [{"id": _group_id(r["id"]), "count": _int(r["count"]), "base": _int(r["base"]),
                      "share": _share(r["share"])} for r in res["rows"]][:10],
            "total_count": _int(res["total_count"]), "total_base": _int(res["total_base"])}


PLAN_ENUMS = {"group_by": ("leaf", "category", "subtheme"), "measure": ("conversations", "people"),
              "signal": (None, "any_friction", "correction", "repeat_request", "assistant_limit", "complaint"),
              "rank_by": ("count", "share")}


def _plan(p: dict | None) -> dict | None:
    if p is None:
        return None
    out = {}
    for k, allowed in PLAN_ENUMS.items():
        if p.get(k) not in allowed:
            raise Blocked("bad plan")
        out[k] = p.get(k)
    out["scope_category_id"] = None if p.get("scope_category_id") is None else _id(p["scope_category_id"], CATEGORY_ID)
    out["scope_leaf_id"] = None if p.get("scope_leaf_id") is None else _id(p["scope_leaf_id"], LEAF_ID)
    lim = _int(p["limit"])
    if not 1 <= lim <= 10:
        raise Blocked("bad plan")
    out["limit"] = lim
    return {k: out[k] for k in ("group_by", "scope_category_id", "scope_leaf_id", "measure", "signal", "rank_by", "limit")}


def _attempts_log(log_: list | None) -> list[dict]:
    out = []
    for a in (log_ or [])[:4]:   # at most A1, B1, A2, B2
        if a.get("program") not in ("A", "B"):
            raise Blocked("bad attempt program")
        out.append({"attempt": 2 if a.get("attempt") == 2 else 1, "program": a["program"], "code": _str(a["code"], 64 * 1024),
                    "code_sha256": _id(a["code_sha256"], SHA256), "receipt": _receipt(a.get("receipt")),
                    "verdict": _verdict(a.get("verdict")) or {"passed": False, "checks": []},
                    "repair_reason": _opt_str(a.get("repair_reason"), 600)})
    return out


def _explanation(e: dict | None) -> dict | None:
    if not e:
        return None
    return {"text": _str(e["text"], 600),
            "metric_refs": [x for x in e.get("metric_refs") or [] if isinstance(x, str) and PLACEHOLDER_KEY.match(x)][:20]}


DESTRUCTIVE_COMMANDS = {"rm -rf --no-preserve-root /"}   # fixed vocabulary; never an arbitrary string


def _tribool(v) -> bool | None:
    return v if isinstance(v, bool) else None


def _destructive(d: dict | None) -> dict | None:
    if not d:
        return None
    ec = d.get("exit_code")
    if ec is not None and (isinstance(ec, bool) or not isinstance(ec, int) or not -512 <= ec <= 512):
        raise Blocked("bad exit code")
    refused = d.get("refused")
    if refused is not None and (isinstance(refused, bool) or not isinstance(refused, int) or not 0 <= refused <= 1_000_000):
        raise Blocked("bad refused count")
    cmd = d.get("command")
    if cmd not in DESTRUCTIVE_COMMANDS:
        raise Blocked("bad destructive command")
    return {"command": cmd, "exit_code": ec, "refused": refused, "container_removed": bool(d["container_removed"]),
            "root_read_only": _tribool(d.get("root_read_only")), "binaries_intact": _tribool(d.get("binaries_intact")),
            "next_run_clean": bool(d["next_run_clean"]), "contained": bool(d["contained"])}


def _opt_share(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise Blocked("bad share")
    f = float(v)
    if not (f == f and -0.0001 <= f <= 1.0001):   # finite and within [0,1]
        raise Blocked("bad share")
    return round(f, 4)


def _intake(k: dict | None) -> dict | None:
    """Intake summary (§11), set only on a completed intake run. Ids and shares are checked like
    every other browser payload; deltas are capped at 8."""
    if not k:
        return None
    deltas = [{"id": _node_id(d["id"]), "conversations_before": _int(d["conversations_before"]),
               "conversations_after": _int(d["conversations_after"]),
               "friction_share_before": _opt_share(d.get("friction_share_before")),
               "friction_share_after": _opt_share(d.get("friction_share_after"))}
              for d in (k.get("deltas") or [])][:8]
    return {"batch_size": _int(k["batch_size"]), "decided": _int(k["decided"]), "other": _int(k["other"]),
            "published_snapshot_id": _id(k["published_snapshot_id"], SNAPSHOT_ID),
            "base_snapshot_id": _id(k["base_snapshot_id"], SNAPSHOT_ID), "deltas": deltas}


def serialize_intake_events(raw: dict) -> dict:
    """Presenter routing diagnostics still cross a trust boundary: allowlist every field."""
    counters = raw["counters"]
    events = []
    for event in raw.get("events", [])[:200]:
        language = _str(event["language"], 60)
        if leakcheck.problems(language):
            language = "Unknown"
        events.append({
            "seq": _int(event["seq"]), "t_ms": _int(event["t_ms"]),
            "leaf_id": _id(event["leaf_id"], LEAF_ID), "p": _opt_share(event["p"]),
            "friction": {s: event.get("friction", {}).get(s) if event.get("friction", {}).get(s)
                         in ("observed", "not_observed", "unclear") else "unclear" for s in SIGNALS},
            "language": language, "turns": _int(event["turns"]), "summary": None,
        })
    state = raw["state"]
    stage = raw["stage"]
    if state not in ("running", "completed", "failed") or stage not in (
            "deciding", "filing", "gating", "publishing", "evaluating", "done"):
        raise Blocked("bad intake state")
    rate = _num(counters["per_second"])
    if not 0 <= rate < float("inf"):
        raise Blocked("bad intake rate")
    out = {"run_id": _id(raw["run_id"], RUN_ID), "state": state, "stage": stage,
           "counters": {"total": _int(counters["total"]), "decided": _int(counters["decided"]),
                        "per_second": rate, "p50_ms": _int(counters["p50_ms"]), "decisions_per_conversation": 5},
           "events": events}
    if state == "completed":
        out["intake"] = _intake(raw.get("intake"))
    elif state == "failed":
        error = raw.get("error") or {}
        code = error.get("code")
        if not isinstance(code, str) or not MAP_KEY.fullmatch(code):
            code = "intake_failed"
        # Upstream/private errors need not be echoed; details remain in the operator's logs.
        out["error"] = {"code": code, "message": "The intake run could not finish; reload to check the current snapshot."}
    return out


def _containment(c: dict | None) -> dict | None:
    if not c:
        return None
    return {"deadline_ms": _int(c["deadline_ms"]), "elapsed_ms": _int(c["elapsed_ms"]), "killed": bool(c["killed"]),
            "container_removed": bool(c["container_removed"]),
            "app_health": "ok" if c.get("app_health") == "ok" else "degraded",
            "destructive": _destructive(c.get("destructive")),
            "followup_passed": bool(c["followup_passed"]), "leak_attempt_rejected": bool(c["leak_attempt_rejected"]),
            "leak_rejection_checks": [_str(x, 80) for x in c.get("leak_rejection_checks") or []][:20]}


def serialize_run(raw: dict) -> dict:
    err = raw.get("error")
    out = {
        "run_id": _id(raw["run_id"], RUN_ID), "kind": raw["kind"], "intent": raw.get("intent"),
        "snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID), "state": raw["state"],
        "created_at": _str(raw["created_at"], 40), "updated_at": _str(raw["updated_at"], 40),
        "stages": [{"name": _str(s["name"], 40), "status": s["status"], "started_at": _opt_str(s.get("started_at"), 40),
                    "finished_at": _opt_str(s.get("finished_at"), 40), "detail": _opt_str(s.get("detail"), 400)}
                   for s in raw["stages"]],
        "attempts": _int(raw.get("attempts", 0)),
        "code": _opt_str(raw.get("code"), 64 * 1024),
        "receipt": _receipt(raw.get("receipt")),
        "verdict": _verdict(raw.get("verdict")),
        "result": _result(raw.get("result")),
        "explanation": _explanation(raw.get("explanation")),
        "containment": _containment(raw.get("containment")),
        "error": {"code": _str(err["code"], 40), "message": _str(err["message"], 300)} if err else None,
        "question": None if raw.get("question") is None else sanitize_question(_str(raw["question"], 200)),
        "plan": _plan(raw.get("plan")),
        "attempts_log": _attempts_log(raw.get("attempts_log")),
        "intake": _intake(raw.get("intake")),
    }
    models.Run.model_validate(out)
    return out


# ---------------------------------------------------------------- stories, eval, search

def serialize_story(raw: dict) -> dict:
    out = {"cluster_id": _id(raw["cluster_id"], LEAF_ID), "snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID),
           "label": _str(raw["label"], 200), "first_name": _str(raw["first_name"], 30), "text": _str(raw["text"], 2000),
           "citations": [_id(c, EVIDENCE_ID) for c in raw.get("citations") or []],
           "model": _str(raw["model"], 60), "generated_at": _str(raw["generated_at"], 40)}
    models.Story.model_validate(out)
    if leakcheck.problems(out["text"]) or leakcheck.problems(out["first_name"]):
        raise Blocked("story failed the leak check")
    return out


def serialize_prd(raw: dict) -> dict:
    pr = raw.get("priority") or {}
    out = {"cluster_id": _id(raw["cluster_id"], LEAF_ID), "snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID),
           "label": _str(raw["label"], 300), "title": _str(raw["title"], 160), "problem": _str(raw["problem"], 1200),
           "user_stories": [_str(s, 600) for s in (raw.get("user_stories") or [])[:4]],
           "requirements": [_str(s, 600) for s in (raw.get("requirements") or [])[:5]],
           "success_metrics": [_str(s, 600) for s in (raw.get("success_metrics") or [])[:4]],
           "citations": [_id(c, EVIDENCE_ID) for c in raw.get("citations") or []],
           "metrics_used": [{"name": _str(m["name"], 40), "value": _str(m["value"], 20)} for m in raw.get("metrics_used") or []],
           "priority": {"level": pr.get("level") if pr.get("level") in ("P0", "P1", "P2") else None,
                        "rank": int(pr["rank"]) if pr.get("rank") is not None else None, "of": int(pr.get("of") or 0),
                        "basis": _str(pr.get("basis") or "", 200)},
           "model": _str(raw["model"], 60), "generated_at": _str(raw["generated_at"], 40)}
    models.Prd.model_validate(out)
    flat = " ".join([out["title"], out["problem"], *out["user_stories"], *out["requirements"], *out["success_metrics"]])
    if leakcheck.problems(flat):
        raise Blocked("prd failed the leak check")
    return out


BRIEF_ID = re.compile(r"^brf_[0-9a-f]{12}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SCENE_TYPES = ("intro", "change", "map", "top_workflows", "friction", "signals", "spotlight", "languages", "takeaways", "outro")
SIGNAL_LABELS = {"correction": "Corrected the assistant", "repeat_request": "Asked again",
                 "assistant_limit": "Assistant couldn't help", "complaint": "Complained"}
BRIEF_PIPELINE = "GLM 5.3 · Jev · gVisor sandbox"


def _brief_leaf(c: dict) -> dict:
    return {"id": _id(c["id"], LEAF_ID), "title": _str(c["title"], 120), "share": _opt_share(c.get("share")),
            "conversations": _int(c["conversations"]), "friction_share": _opt_share(c.get("friction_share"))}


def _scene_data(kind: str, d: Any) -> dict | None:
    if not isinstance(d, dict):
        return None
    if kind == "map":
        return {"categories": [{"id": _id(c["id"], CATEGORY_ID), "title": _str(c["title"], 120),
                                "share": _opt_share(c.get("share")), "conversations": _int(c["conversations"]),
                                "friction_share": _opt_share(c.get("friction_share")), "is_other": bool(c.get("is_other")),
                                "children": [_brief_leaf(k) for k in c.get("children") or []][:40]}
                               for c in d.get("categories") or []][:20]}
    if kind == "top_workflows":
        return {"items": [{"id": _id(x["id"], LEAF_ID), "title": _str(x["title"], 120), "category": _str(x.get("category") or "", 120),
                           "share": _opt_share(x.get("share")), "conversations": _int(x["conversations"]),
                           "people": _int(x["people"])} for x in d.get("items") or []][:6]}
    if kind == "friction":
        return {"overall_share": _opt_share(d.get("overall_share")),
                "items": [{"id": _id(x["id"], LEAF_ID), "title": _str(x["title"], 120),
                           "friction_share": _opt_share(x.get("friction_share")),
                           "friction_conversations": _int(x["friction_conversations"]),
                           "conversations": _int(x["conversations"])} for x in d.get("items") or []][:6]}
    if kind == "signals":
        items = []
        for x in (d.get("items") or [])[:4]:
            if x.get("signal") not in SIGNAL_LABELS:
                raise Blocked("bad signal")
            items.append({"signal": x["signal"], "label": SIGNAL_LABELS[x["signal"]], "conversations": _int(x["conversations"])})
        return {"friction_conversations": _int(d["friction_conversations"]), "items": items}
    if kind == "spotlight":
        sig = d.get("signals") or {}
        return {"id": _id(d["id"], LEAF_ID), "title": _str(d["title"], 120), "category": _str(d.get("category") or "", 120),
                "description": _str(d.get("description") or "", 600), "share": _opt_share(d.get("share")),
                "conversations": _int(d["conversations"]), "people": _int(d["people"]),
                "friction_share": _opt_share(d.get("friction_share")), "signals": {s: _int(sig.get(s, 0)) for s in SIGNALS},
                "problems": [_str(x, 300) for x in d.get("problems") or []][:4],
                "needs": [_str(x, 300) for x in d.get("needs") or []][:4]}
    if kind == "languages":
        return {"languages": _int(d["languages"]),
                "items": [{"name": _str(x["name"], 60), "conversations": _int(x["conversations"]),
                           "share": _opt_share(x.get("share")) or 0.0} for x in d.get("items") or []][:8]}
    if kind == "outro":
        return {"snapshot_id": _id(d["snapshot_id"], SNAPSHOT_ID), "pipeline": BRIEF_PIPELINE}
    if kind == "change":
        return {"base_snapshot_id": _id(d["base_snapshot_id"], SNAPSHOT_ID),
                "conversations_before": _int(d["conversations_before"]), "conversations_after": _int(d["conversations_after"]),
                "added_conversations": _int(d["added_conversations"]),
                "friction_share_before": _opt_share(d.get("friction_share_before")),
                "friction_share_after": _opt_share(d.get("friction_share_after")),
                "items": [{"id": _id(x["id"], LEAF_ID), "title": _str(x["title"], 120), "before": _int(x["before"]),
                           "after": _int(x["after"]), "friction_share_before": _opt_share(x.get("friction_share_before")),
                           "friction_share_after": _opt_share(x.get("friction_share_after"))}
                          for x in d.get("items") or []][:6]}
    return None


def _brief_scene(s: dict) -> dict:
    kind = s.get("type")
    if kind not in SCENE_TYPES:
        raise Blocked("bad scene type")
    out = {"type": kind, "seconds": _int(s["seconds"]), "from_frame": _int(s["from_frame"]), "frames": _int(s["frames"]),
           "headline": _str(s["headline"], 160)}
    if kind == "intro" and s.get("kicker"):
        out["kicker"] = _str(s["kicker"], 200)
    if kind == "spotlight":
        out["cluster_id"] = _id(s["cluster_id"], LEAF_ID)
        out["insight"] = _str(s["insight"], 400)
    if kind == "takeaways":
        out["bullets"] = [_str(b, 240) for b in s.get("bullets") or []][:3]
    data = _scene_data(kind, s.get("data"))
    if data is not None:
        out["data"] = data
    return out


VIDEO_STATUSES = {"ready", "rendering", "failed", "none", "unavailable"}


def serialize_brief(raw: dict, video: str = "unavailable") -> dict:
    """`video` is the MP4 export status from brief_video.status(); the URL is ours, never stored."""
    ds, t = raw["dataset"], raw["totals"]
    out = {"brief_id": _id(raw["brief_id"], BRIEF_ID), "snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID),
           "generated_at": _str(raw["generated_at"], 40), "model": _str(raw["model"], 60), "label": _str(raw["label"], 300),
           "fps": _int(raw["fps"]), "width": _int(raw["width"]), "height": _int(raw["height"]),
           "duration_frames": _int(raw["duration_frames"]), "title": _str(raw["title"], 160),
           "dataset": {"name": _str(ds["name"], 60), "workspace": _str(ds["workspace"], 120),
                       "period_start": _id(ds["period_start"], DATE), "period_end": _id(ds["period_end"], DATE)},
           "totals": {"conversations": _int(t["conversations"]), "people": _int(t["people"]), "languages": _int(t["languages"]),
                      "friction_share": _opt_share(t.get("friction_share")),
                      "friction_conversations": _int(t["friction_conversations"]), "unclear": _int(t["unclear"])},
           "scenes": [_brief_scene(s) for s in raw.get("scenes") or []][:10],
           "metrics_used": [{"name": _str(m["name"], 60), "value": _str(m["value"], 40)} for m in raw.get("metrics_used") or []][:40],
           "checks": [_str(c, 200) for c in raw.get("checks") or []][:12],
           "attempts": _int(raw.get("attempts", 1)),
           "video_status": video if video in VIDEO_STATUSES else "unavailable", "video_url": None}
    if out["video_status"] == "ready":
        out["video_url"] = f"/api/brief/{out['brief_id']}/video.mp4"
    models.Brief.model_validate(out)
    if leakcheck.problems(json.dumps(out, ensure_ascii=False), contact=False):
        raise Blocked("brief failed the leak check")
    free = [out["title"]] + [x for s in out["scenes"]
                             for x in [s["headline"], s.get("kicker") or "", s.get("insight") or "", *(s.get("bullets") or [])]]
    if leakcheck.problems(" ".join(free)):
        raise Blocked("brief text failed the leak check")
    return out


def serialize_eval(raw: dict) -> dict:
    out = {"snapshot_id": _id(raw["snapshot_id"], SNAPSHOT_ID), "generated_at": _str(raw["generated_at"], 40),
           "checks": [{"id": _str(c["id"], 60), "name": _str(c["name"], 160), "value": _str(str(c.get("value", "")), 200),
                       "target": _str(str(c.get("target", "")), 200),
                       "passed": None if c.get("passed") is None else bool(c["passed"]), "detail": _str(str(c.get("detail", "")), 600)}
                      for c in raw.get("checks") or []]}
    models.EvalReport.model_validate(out)
    if leakcheck.problems(json.dumps(out, ensure_ascii=False), contact=False):
        raise Blocked("eval report failed the leak check")
    return out


def serialize_search(snapshot_id: str, query: str, results: list[dict], elapsed_ms: int) -> dict:
    return {"snapshot_id": _id(snapshot_id, SNAPSHOT_ID), "query": _str(query, 200),
            "results": [{"cluster_id": _id(r["cluster_id"], LEAF_ID),
                         "relevance": r["relevance"] if r["relevance"] in ("relevant", "unclear", "not_relevant") else "unclear",
                         "p": round(_num(r["p"]), 4)} for r in results],
            "elapsed_ms": _int(elapsed_ms)}


# ---------------------------------------------------------------- sub-themes

SUBTHEME_ID = re.compile(r"^cl_(?:[0-9a-f]{6}|other)_(?:s\d{1,2}|rest)$")


def serialize_subthemes(snapshot_id: str, raw: dict) -> dict:
    """Only ids, short titles (or null), integer counts and the rest flag. A canary token anywhere blocks
    the payload; a title matching a contact pattern is dropped to null."""
    leaves: dict[str, list[dict]] = {}
    for lid, items in (raw.get("leaves") or {}).items():
        lid = _id(lid, LEAF_ID)
        out = []
        for x in items or []:
            sid = _id(x["id"], SUBTHEME_ID)
            if not sid.startswith(lid + "_"):
                raise Blocked("bad id")
            title = _opt_str(x.get("short_title"), SHORT_TITLE_MAX)
            if title is not None:
                found = leakcheck.problems(title)
                if "canary token" in found:
                    raise Blocked("sub-theme title failed the canary check")
                if found:
                    title = None
            item = {"id": sid, "short_title": title, "conversations": _int(x["conversations"]), "users": _int(x["users"])}
            if x.get("rest"):
                item["rest"] = True
            out.append(item)
        leaves[lid] = out
    out = {"snapshot_id": _id(snapshot_id, SNAPSHOT_ID), "base_snapshot_id": _id(raw["base_snapshot_id"], SNAPSHOT_ID),
           "leaves": leaves}
    if leakcheck.problems(json.dumps(out, ensure_ascii=False), contact=False):
        raise Blocked("sub-themes failed the leak check")
    return out
