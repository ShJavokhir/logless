"""The egress gate: the only path from sandbox output to anything the product stores or serves.

It runs on the app VM, outside the sandbox, and never computes the answer itself (docs/CONTRACTS.md
§0). For each program's output it checks, in order:

  1. per-program: one strictly parsed JSON document ≤ 1 MiB within structural limits; only
     allowlisted field names and string values; the exact schema with the plan echoed exactly;
     ids within the plan's scope (never Other); integers ≥ 0, count ≤ base, share = count ÷ base
     (±1e-4); totals consistent with the rows; ordering by rank_by desc then id; length =
     min(limit, groups in scope);
  2. consistency with the PUBLISHED snapshot wherever the plan makes it derivable (the snapshot
     comes from the pipeline, the programs from the agent, so these are genuine cross-checks);
  3. agreement: two independently written programs must produce identical canonical results.

What is served is the sandbox output itself, canonicalized (shares recomputed from the program's
own integers and rounded to 4 decimals). Check names and details come from a fixed vocabulary
and never echo output values."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from .plan import PLAN_KEYS, PLAN_STRINGS, Plan, question_scope

MAX_BYTES = 1024 * 1024
MAX_ROWS = 1000
# Structural limits, checked iteratively right after parsing and before anything walks the
# document, so a crafted < 1 MiB output cannot amplify into huge diagnostics or deep recursion.
MAX_DEPTH = 4          # root > rows > row > value
MAX_VALUES = 20_000    # containers + scalars
MAX_KEYS = 32
MAX_STR = 64           # every allowlisted string (ids, plan words) is far shorter
MAX_DIAGNOSTICS = 20   # per check; the rest are only counted
MAX_COUNT = 2**53 - 1  # exact in the browser's JSON number representation
SHARE_TOL = 1e-4

# Check names shown in the UI's Run details (fixed vocabulary).
C_OUTPUT = "Result file received"
C_SIZE = "Size within 1 MiB"
C_PARSE = "Strict JSON parse"
C_SHAPE = "Document within structural limits"
C_FIELDS = "Only allowlisted field names"
C_STRINGS = "Only allowlisted string values"
C_SCHEMA = "Schema matches exactly"
C_INTENT = "Intent matches the request"
C_SNAPSHOT = "Snapshot id is the current snapshot"
C_PLAN = "Plan echoed exactly"
C_SCOPE = "Ids are within the question's scope (no Other)"
C_NONNEG = "Counts are non-negative integers"
C_ARITH = "count ≤ base and share = count ÷ base"
C_TOTALS = "Totals consistent with the rows"
C_ORDER = "Ranked as the plan says (rank desc, then id)"
C_LENGTH = "Row count is min(limit, groups in scope)"
MAP = "Consistent with the published map"
C_MAP_SUMMARY = "Matches the published map"    # per-program summary in attempt verdicts
SIGNAL_NAMES = {"any_friction": "friction", "correction": "correction", "repeat_request": "repeat-request",
                "assistant_limit": "assistant-limit", "complaint": "complaint"}


def map_check_name(what: str) -> str:
    return f"{MAP} · {what}"
C_AGREE = "Two independent programs agree"

FIELDS = frozenset({"intent", "snapshot_id", "plan", "rows", "id", "count", "base", "share", "total_count",
                    "total_base", *PLAN_KEYS})
# Names we may quote in a detail even though they are not allowed: our own schema, the input
# columns and obvious per-record identifiers. Anything else is reported as "an unknown field".
QUOTABLE = FIELDS | {"row", "user", "leaf_id", "category_id", "subtheme_id", "user_id", "conv_id", "conversation_id", "text", "name",
                     "email", "content", "message", "level", "parent_id", "is_other", "correction", "repeat_request",
                     "assistant_limit", "complaint", "users", "conversations", "cluster_id"}


class _Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class QuestionRow(_Strict):
    id: str
    count: int
    base: int
    share: float


class QuestionResult(_Strict):
    intent: str
    snapshot_id: str
    plan: dict
    rows: list[QuestionRow]
    total_count: int
    total_base: int


# ---------------------------------------------------------------- verdict

@dataclass
class Check:
    name: str
    passed: bool
    detail: str


@dataclass
class Verdict:
    passed: bool
    checks: list[Check] = field(default_factory=list)
    canonical: dict | None = None     # the program's own result, canonicalized — set only when passed

    def public(self) -> dict:
        return {"passed": self.passed, "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in self.checks]}

    @property
    def failed_names(self) -> list[str]:
        return [c.name for c in self.checks if not c.passed]


class _Reject(Exception):
    def __init__(self, detail: str):
        self.detail = detail


def strict_loads(text: str) -> Any:
    def pairs(items):
        d: dict = {}
        for k, v in items:
            if k in d:
                raise _Reject("duplicate key in an object")
            d[k] = v
        return d

    def const(_):
        raise _Reject("NaN or Infinity is not allowed")

    def pfloat(s: str) -> float:
        f = float(s)
        if not math.isfinite(f):
            raise _Reject("number out of range")
        return f

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=const, parse_float=pfloat)
    except _Reject:
        raise
    except RecursionError:
        raise _Reject("nesting too deep") from None
    except ValueError:
        raise _Reject("not a single valid JSON document") from None


def _path(parent: str, key: Any) -> str:
    if isinstance(key, int):
        return f"{parent}[{key}]"
    name = key if key in QUOTABLE else "<unknown>"
    return f"{parent}.{name}" if parent else name


def _where(parent: str) -> str:
    return parent if parent else "the top level"


class _Diag(list):
    """A bounded list of diagnostics: keeps the first MAX_DIAGNOSTICS, counts the rest."""

    def __init__(self):
        super().__init__()
        self.total = 0

    def add(self, msg: str) -> None:
        self.total += 1
        if len(self) < MAX_DIAGNOSTICS:
            self.append(msg)


def shape_problem(doc: Any) -> str | None:
    """Iterative, early-exit structural check. Returns a fixed-vocabulary reason, or None."""
    stack: list[tuple[Any, int]] = [(doc, 1)]
    seen = 0
    while stack:
        node, depth = stack.pop()
        seen += 1
        if seen > MAX_VALUES:
            return f"more than {MAX_VALUES:,} values"
        if depth > MAX_DEPTH:
            return f"nested deeper than {MAX_DEPTH} levels"
        if isinstance(node, dict):
            if len(node) > MAX_KEYS:
                return f"an object has more than {MAX_KEYS} fields"
            for k, v in node.items():
                if len(k) > MAX_STR:
                    return f"a field name is longer than {MAX_STR} characters"
                stack.append((v, depth + 1))
        elif isinstance(node, list):
            if len(node) > MAX_ROWS:
                return f"a list has more than {MAX_ROWS} entries"
            stack.extend((v, depth + 1) for v in node)
        elif isinstance(node, str) and len(node) > MAX_STR:
            return f"a string is longer than {MAX_STR} characters"
        elif type(node) is int and abs(node) > MAX_COUNT:
            return "an integer exceeds the safe count range"
    return None


def _walk(doc: Any, allowed_strings: set[str], bad_fields: _Diag, bad_strings: _Diag, parent: str = "") -> None:
    # Only called after shape_problem() passed: depth <= MAX_DEPTH, so paths stay short.
    if isinstance(doc, dict):
        for k, v in doc.items():
            if k not in FIELDS:
                bad_fields.add(f"unknown field '{k}' in {_where(parent)}" if k in QUOTABLE else f"unknown field in {_where(parent)}")
            _walk(v, allowed_strings, bad_fields, bad_strings, _path(parent, k))
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            _walk(v, allowed_strings, bad_fields, bad_strings, _path(parent, i))
    elif isinstance(doc, str):
        if doc not in allowed_strings:
            bad_strings.add(f"string value at {_where(parent)} is not allowlisted")


def _summarize(items: list[str], limit: int = 3) -> str:
    if not items:
        return "ok"
    total = getattr(items, "total", None) or len(items)
    more = f" (+{total - limit} more)" if total > limit else ""
    return "; ".join(items[:limit]) + more


def _schema_errors(e: ValidationError) -> _Diag:
    out = _Diag()
    for err in e.errors()[:MAX_DIAGNOSTICS]:
        path = ""
        for part in err.get("loc", ()):
            path = _path(path, part)
        t = err.get("type", "")
        if t == "extra_forbidden":
            out.append(f"unknown field at {_where(path)}")
        elif t == "missing":
            out.append(f"missing field at {_where(path)}")
        elif t.startswith("int"):
            out.append(f"{_where(path)} must be an integer")
        elif t.startswith("float"):
            out.append(f"{_where(path)} must be a number")
        elif t.startswith("string"):
            out.append(f"{_where(path)} must be a string")
        elif t.startswith(("list", "model", "dict")):
            out.append(f"{_where(path)} has the wrong structure")
        else:
            out.append(f"{_where(path)} is invalid")
    out.total = e.error_count()
    return out


def _ints(doc: Any, parent: str = "") -> list[tuple[str, int]]:
    if isinstance(doc, dict):
        return [x for k, v in doc.items() for x in _ints(v, _path(parent, k))]
    if isinstance(doc, list):
        return [x for i, v in enumerate(doc) for x in _ints(v, _path(parent, i))]
    if isinstance(doc, int) and not isinstance(doc, bool):
        return [(parent, doc)]
    return []


def sort_key(rank_by: str):
    """rank_by desc, then id asc. Shares compare as exact fractions of the program's own integers,
    so float rounding can never reorder near-ties."""
    if rank_by == "count":
        return lambda r: (-r["count"], r["id"])
    return lambda r: (-(Fraction(r["count"], r["base"]) if r["base"] else Fraction(0)), r["id"])


def canonicalize(doc: dict) -> dict:
    """The served form of a program's result: keys in contract order, shares recomputed from the
    program's own integers and rounded to 4 decimals."""
    return {
        "intent": "question", "snapshot_id": doc["snapshot_id"], "plan": {k: doc["plan"][k] for k in PLAN_KEYS},
        "rows": [{"id": r["id"], "count": r["count"], "base": r["base"],
                  "share": round(r["count"] / r["base"], 4) if r["base"] else 0.0} for r in doc["rows"]],
        "total_count": doc["total_count"], "total_base": doc["total_base"],
    }


# ---------------------------------------------------------------- 1. per-program checks

def check_program(output: str | None, *, snapshot_id: str, plan: dict, clusters: list[dict],
                  leaf_ids: list[str], category_ids: list[str]) -> Verdict:
    """Validate one program's output against the validated plan. No reference answer is used."""
    plan = Plan.model_validate(plan).model_dump()
    v = Verdict(passed=False)

    def add(name: str, ok: bool, detail: str) -> bool:
        v.checks.append(Check(name, ok, detail))
        return ok

    if not add(C_OUTPUT, output is not None, "a result file was produced" if output is not None else "the job produced no result file"):
        return v
    try:
        size = len(output.encode("utf-8"))
    except UnicodeEncodeError:
        add(C_PARSE, False, "the document is not valid UTF-8")
        return v
    if not add(C_SIZE, size <= MAX_BYTES, f"{size:,} bytes" if size <= MAX_BYTES else "result exceeds 1 MiB"):
        return v
    try:
        doc = strict_loads(output)
        ok = isinstance(doc, dict)
        add(C_PARSE, ok, "one JSON object" if ok else "the document is not a JSON object")
        if not ok:
            return v
    except _Reject as e:
        add(C_PARSE, False, e.detail)
        return v
    problem = shape_problem(doc)
    if not add(C_SHAPE, problem is None, problem or f"depth <= {MAX_DEPTH}, strings <= {MAX_STR} chars"):
        return v

    subtheme_ids = [c["id"] for c in clusters if int(c["level"]) == 3]
    allowed = {"question", snapshot_id, *leaf_ids, *category_ids, *subtheme_ids, *PLAN_STRINGS}
    bad_fields, bad_strings = _Diag(), _Diag()
    _walk(doc, allowed, bad_fields, bad_strings)
    add(C_FIELDS, not bad_fields, _summarize(bad_fields) if bad_fields else "all field names are in the schema")
    add(C_STRINGS, not bad_strings, _summarize(bad_strings) if bad_strings else "only plan words, snapshot and node ids")

    try:
        parsed = QuestionResult.model_validate(doc)
        echoed = Plan.model_validate(parsed.plan)
        add(C_SCHEMA, True, "question result schema, no extra fields")
    except ValidationError as e:
        add(C_SCHEMA, False, _summarize(_schema_errors(e)))
        return v

    prog = parsed.model_dump()
    add(C_INTENT, prog["intent"] == "question", "matches" if prog["intent"] == "question" else "the result names a different intent")
    add(C_SNAPSHOT, prog["snapshot_id"] == snapshot_id,
        "matches" if prog["snapshot_id"] == snapshot_id else "the result names a different snapshot")
    same_plan = set(parsed.plan) == set(PLAN_KEYS) and echoed.model_dump() == Plan.model_validate(plan).model_dump()
    add(C_PLAN, same_plan, "identical to the validated plan" if same_plan else "the echoed plan differs from the validated plan")

    groups, _ = question_scope(clusters, plan)
    rows = prog["rows"]
    ids = [r["id"] for r in rows]
    outside = _Diag()
    for i, x in enumerate(ids):
        if x not in groups:
            outside.add(f"rows[{i}] is not a group in the question's scope")
    if len(set(ids)) != len(ids):
        outside.add("an id appears more than once")
    add(C_SCOPE, not outside, _summarize(outside) if outside else f"{len(ids)} ids, all in scope")

    negative = _Diag()
    for p, n in _ints(prog):
        if n < 0:
            negative.add(f"{p} is negative")
    add(C_NONNEG, not negative, _summarize(negative) if negative else "ok")

    arith = _Diag()
    for i, r in enumerate(rows):
        if r["count"] > r["base"]:
            arith.add(f"rows[{i}].count exceeds its base")
        if plan["signal"] is None and r["count"] != r["base"]:
            arith.add(f"rows[{i}].count must equal its base without a signal filter")
        want = r["count"] / r["base"] if r["base"] else 0.0
        if abs(r["share"] - want) > SHARE_TOL:
            arith.add(f"rows[{i}].share is not count ÷ base")
    add(C_ARITH, not arith, _summarize(arith) if arith else "every row")

    tot = _Diag()
    if prog["total_count"] > prog["total_base"]:
        tot.add("total_count exceeds total_base")
    if plan["signal"] is None and prog["total_count"] != prog["total_base"]:
        tot.add("without a signal filter, total_count must equal total_base")
    if not groups and (prog["total_count"] or prog["total_base"]):
        tot.add("totals must be zero for an empty scope")
    if rows:
        if prog["total_base"] < max(r["base"] for r in rows) or prog["total_count"] < max(r["count"] for r in rows):
            tot.add("a total is smaller than one of its rows")
        additive = plan["measure"] == "conversations"   # conversations partition across groups; people don't
        if additive and len(rows) == len(groups):
            if prog["total_base"] != sum(r["base"] for r in rows) or prog["total_count"] != sum(r["count"] for r in rows):
                tot.add("totals differ from the sum of all groups")
        elif additive and (prog["total_base"] < sum(r["base"] for r in rows) or prog["total_count"] < sum(r["count"] for r in rows)):
            tot.add("totals are smaller than the sum of the listed groups")
        if not additive and len(rows) == len(groups) and (
                prog["total_base"] > sum(r["base"] for r in rows) or prog["total_count"] > sum(r["count"] for r in rows)):
            tot.add("distinct-people totals exceed the sum of all groups")
    add(C_TOTALS, not tot, _summarize(tot) if tot else "ok")

    ordered = [r["id"] for r in sorted(rows, key=sort_key(plan["rank_by"]))] == ids
    first_bad = next((i for i, (a, b) in enumerate(zip(ids, [r["id"] for r in sorted(rows, key=sort_key(plan["rank_by"]))])) if a != b), None)
    add(C_ORDER, ordered, "ok" if ordered else f"rows[{first_bad}] is out of order")

    want_len = min(plan["limit"], len(groups))
    add(C_LENGTH, len(rows) == want_len, f"{want_len} rows" if len(rows) == want_len else f"expected {want_len} rows")

    v.passed = all(c.passed for c in v.checks)
    if v.passed:
        v.canonical = canonicalize(prog)
    return v


# ---------------------------------------------------------------- 2. consistency with the published snapshot

def check_snapshot(result: dict, *, plan: dict, clusters: list[dict], nodes: dict[str, dict]) -> list[Check]:
    """Cross-checks against the published snapshot's node metrics (computed by the pipeline's own
    code), only where the plan makes them derivable. `nodes` maps published ids to snapshot nodes
    (sub-theme nodes carry only conversations and users)."""
    groups, leaves = question_scope(clusters, plan)
    if plan["group_by"] == "subtheme":
        return _check_subthemes(result, plan=plan, groups=groups, nodes=nodes)
    children: dict[str, list[str]] = {}
    for c in clusters:
        if int(c["level"]) == 2:
            children.setdefault(c["parent_id"], []).append(c["id"])

    def derivable_node(gid: str) -> bool:
        if gid not in nodes:
            return False
        if plan["group_by"] == "leaf":
            return True
        return all(x in leaves for x in children.get(gid, []))   # category = exactly its in-scope leaves

    checks: list[Check] = []
    rows = result["rows"]
    measure, signal = plan["measure"], plan["signal"]

    # base = the measure with no signal filter, per group: conversations or people (users)
    field = "conversations" if measure == "conversations" else "users"
    bad = _Diag()
    checked = 0
    for i, r in enumerate(rows):
        if derivable_node(r["id"]):
            checked += 1
            if r["base"] != nodes[r["id"]][field]:
                bad.add(f"rows[{i}].base differs from the published {field}")
    if checked:
        what = "base = published conversations" if field == "conversations" else "base = published people"
        checks.append(Check(map_check_name(what), not bad, _summarize(bad) if bad else f"{checked} rows match"))

    # count with a signal filter, conversations only (people counts per signal aren't published)
    if measure == "conversations" and signal is not None:
        bad, checked = _Diag(), 0
        for i, r in enumerate(rows):
            if derivable_node(r["id"]):
                checked += 1
                f = nodes[r["id"]]["friction"]
                want = f["conversations"] if signal == "any_friction" else f["signals"][signal]
                if r["count"] != want:
                    bad.add(f"rows[{i}].count differs from the published friction numbers")
        if checked:
            checks.append(Check(map_check_name(f"count = published {SIGNAL_NAMES[signal]} conversations"), not bad,
                                _summarize(bad) if bad else f"{checked} rows match"))

    # totals: conversations partition across leaves, so the scope total is a sum of published leaves;
    # distinct people are only derivable when the scope is exactly one published category.
    tot = _Diag()
    derivable = False
    if measure == "conversations" and all(x in nodes for x in leaves):
        derivable = True
        if result["total_base"] != sum(nodes[x]["conversations"] for x in leaves):
            tot.add("total_base differs from the published conversations in scope")
        if signal is not None:
            key = (lambda f: f["conversations"]) if signal == "any_friction" else (lambda f: f["signals"][signal])
            if result["total_count"] != sum(key(nodes[x]["friction"]) for x in leaves):
                tot.add("total_count differs from the published friction numbers in scope")
        elif result["total_count"] != result["total_base"]:
            tot.add("with no signal filter, total_count must equal total_base")
    elif measure == "people" and plan.get("scope_category_id") and plan["scope_category_id"] in nodes \
            and all(x in leaves for x in children.get(plan["scope_category_id"], [])):
        derivable = True
        if result["total_base"] != nodes[plan["scope_category_id"]]["users"]:
            tot.add("total_base differs from the category's published people")
    if derivable:
        checks.append(Check(map_check_name("totals = published scope totals"), not tot, _summarize(tot) if tot else "matches"))

    # Checking only the submitted rows cannot detect a consistently wrong top-N selection.
    # Compare membership/order with the public map whenever every ranking value is derivable;
    # this does not inspect private rows or substitute a computed answer for sandbox output.
    if (signal is None or measure == "conversations") and all(derivable_node(g) for g in groups):
        ranked = []
        for gid in groups:
            node = nodes[gid]
            base = node[field]
            count = base if signal is None else (node["friction"]["conversations"] if signal == "any_friction"
                                                else node["friction"]["signals"][signal])
            ranked.append({"id": gid, "count": count, "base": base})
        expected = [r["id"] for r in sorted(ranked, key=sort_key(plan["rank_by"]))[:plan["limit"]]]
        matches = [r["id"] for r in rows] == expected
        checks.append(Check(map_check_name("top groups = published ranking"), matches,
                            "matches" if matches else "the selected groups differ from the published ranking"))
    return checks


def _check_subthemes(result: dict, *, plan: dict, groups: list[str], nodes: dict[str, dict]) -> list[Check]:
    """Sub-themes publish only conversations and people per sub-theme (no friction), so the base per
    row, the conversation total and, without a signal filter, the ranking are derivable."""
    checks: list[Check] = []
    rows = result["rows"]
    measure, signal = plan["measure"], plan["signal"]
    field = "conversations" if measure == "conversations" else "users"
    bad, checked = _Diag(), 0
    for i, r in enumerate(rows):
        if r["id"] in nodes:
            checked += 1
            if r["base"] != nodes[r["id"]][field]:
                bad.add(f"rows[{i}].base differs from the published {field}")
    if checked:
        what = "base = published conversations" if field == "conversations" else "base = published people"
        checks.append(Check(map_check_name(what), not bad, _summarize(bad) if bad else f"{checked} rows match"))
    derivable = all(g in nodes for g in groups)
    if measure == "conversations" and derivable:
        tot = _Diag()
        if result["total_base"] != sum(nodes[g]["conversations"] for g in groups):
            tot.add("total_base differs from the published conversations in scope")
        if signal is None and result["total_count"] != result["total_base"]:
            tot.add("with no signal filter, total_count must equal total_base")
        checks.append(Check(map_check_name("totals = published scope totals"), not tot, _summarize(tot) if tot else "matches"))
    if signal is None and derivable:
        ranked = [{"id": g, "count": nodes[g][field], "base": nodes[g][field]} for g in groups]
        expected = [r["id"] for r in sorted(ranked, key=sort_key(plan["rank_by"]))[:plan["limit"]]]
        matches = [r["id"] for r in rows] == expected
        checks.append(Check(map_check_name("top groups = published ranking"), matches,
                            "matches" if matches else "the selected groups differ from the published ranking"))
    return checks


# ---------------------------------------------------------------- 3. agreement

def check_agreement(a: dict, b: dict) -> Check:
    """Canonical equality of two independently written programs' results. Details name positions
    and fields only, never values."""
    if a == b:
        return Check(C_AGREE, True, "identical canonical results")
    diffs = _Diag()
    if len(a["rows"]) != len(b["rows"]):
        diffs.add("Programs disagree on the number of rows")
    for i, (ra, rb) in enumerate(zip(a["rows"], b["rows"])):
        for f in ("id", "count", "base", "share"):
            if ra[f] != rb[f]:
                diffs.add(f"Programs disagree on row {i} · {f}")
    for f in ("total_count", "total_base"):
        if a[f] != b[f]:
            diffs.add(f"Programs disagree on {f}")
    return Check(C_AGREE, False, _summarize(diffs) if diffs else "Programs disagree")
