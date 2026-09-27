"""The egress gate: the only path from sandbox output to anything the product stores or serves.

It runs on the app VM, outside the sandbox. A result passes only if it is one strictly parsed
JSON document ≤ 1 MiB, uses only allowlisted field names and string values, matches the exact
schema for its intent, names the current snapshot and only its clusters, covers every leaf once,
equals the trusted reference (integers exactly, shares within 1e-4) and follows the ordering
rule. On pass the caller stores the REFERENCE values (rounded), never the sandbox bytes.

Check names and details come from a fixed vocabulary. Details never echo output values: field
names are only named when they belong to our own schema or input columns, and positions are
given as structural paths (e.g. "rows[3].users")."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from .export import SIGNALS
from .reference import rounded

MAX_BYTES = 1024 * 1024
MAX_ROWS = 1000
# Structural limits, checked iteratively right after parsing and before anything walks the
# document, so a crafted < 1 MiB output cannot amplify into huge diagnostics or deep recursion.
MAX_DEPTH = 6          # aggregate: root > nodes > node > friction > signals > value
MAX_VALUES = 40_000    # containers + scalars
MAX_KEYS = 32
MAX_STR = 64           # every allowlisted string (ids, intents) is far shorter
MAX_DIAGNOSTICS = 20   # per check; the rest are only counted
DEFAULT_OTHER = frozenset({"cl_other"})
SHARE_TOL = 1e-4
INTENTS = ("usage", "friction", "aggregate")

# Check names shown in the UI's Run details.
C_OUTPUT = "Result file received"
C_SIZE = "Size within 1 MiB"
C_PARSE = "Strict JSON parse"
C_SHAPE = "Document within structural limits"
C_FIELDS = "Only allowlisted field names"
C_STRINGS = "Only allowlisted string values"
C_SCHEMA = "Schema matches exactly"
C_INTENT = "Intent matches the request"
C_SNAPSHOT = "Snapshot id is the current snapshot"
C_IDS = "Cluster ids belong to this snapshot"
C_NONNEG = "Counts are non-negative integers"
C_COVERAGE = "Every leaf exactly once"
C_COVERAGE_AGG = "Every category and leaf exactly once"
C_TOTAL = "Total matches the trusted reference"
C_COUNTS = "Counts match the trusted reference"
C_SHARES = "Shares within 1e-4 of the reference"
C_ORDER = {
    "usage": "Ordered by conversations, then cluster id (Other last)",
    "friction": "Ordered by friction conversations, then cluster id (Other last)",
    "aggregate": "Ordered categories, then leaves, by id",
}

SCHEMA_FIELDS = {
    "intent", "snapshot_id", "total_conversations", "rows", "cluster_id", "conversations", "users", "share",
    "friction_conversations", "friction_share", "unclear", "totals", "nodes", "id", "friction", "signals", *SIGNALS,
}
# Names we may quote in a detail even though they are not allowed: our own input columns and the
# obvious per-record identifiers. Anything else is reported as "an unknown field".
QUOTABLE = SCHEMA_FIELDS | {"row", "user", "leaf_id", "category_id", "user_id", "conv_id", "conversation_id",
                            "text", "name", "email", "content", "message", "level", "parent_id", "is_other"}


# ---------------------------------------------------------------- result schemas (strict)

class _Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class UsageRow(_Strict):
    cluster_id: str
    conversations: int
    users: int
    share: float


class UsageResult(_Strict):
    intent: str
    snapshot_id: str
    total_conversations: int
    rows: list[UsageRow]


class FrictionRow(_Strict):
    cluster_id: str
    conversations: int
    friction_conversations: int
    friction_share: float
    correction: int
    repeat_request: int
    assistant_limit: int
    complaint: int
    unclear: int


class FrictionResult(_Strict):
    intent: str
    snapshot_id: str
    total_conversations: int
    rows: list[FrictionRow]


class Signals(_Strict):
    correction: int
    repeat_request: int
    assistant_limit: int
    complaint: int


class NodeFriction(_Strict):
    conversations: int
    share: float | None
    unclear: int
    signals: Signals


class NodeMetrics(_Strict):
    conversations: int
    users: int
    share: float
    friction: NodeFriction


class AggNode(NodeMetrics):
    id: str


class AggregateResult(_Strict):
    intent: str
    snapshot_id: str
    total_conversations: int
    totals: NodeMetrics
    nodes: list[AggNode]


MODELS: dict[str, type[_Strict]] = {"usage": UsageResult, "friction": FrictionResult, "aggregate": AggregateResult}


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
    canonical: dict | None = None     # reference values (rounded) — set only when passed

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
    return None


def _walk(doc: Any, allowed_strings: set[str], bad_fields: _Diag, bad_strings: _Diag, parent: str = "") -> None:
    # Only called after shape_problem() passed: depth <= MAX_DEPTH, so paths stay short.
    if isinstance(doc, dict):
        for k, v in doc.items():
            if k not in SCHEMA_FIELDS:
                bad_fields.add(f"unknown field '{k}' in {_where(parent)}" if k in QUOTABLE else f"unknown field in {_where(parent)}")
            _walk(v, allowed_strings, bad_fields, bad_strings, _path(parent, k))
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            _walk(v, allowed_strings, bad_fields, bad_strings, _path(parent, i))
    elif isinstance(doc, str):
        if doc not in allowed_strings:
            bad_strings.add(f"string value at {_where(parent)} is not allowlisted")


def _summarize(items: list[str], limit: int = 3, total: int | None = None) -> str:
    if not items:
        return "ok"
    total = getattr(items, "total", None) or total or len(items)
    more = f" (+{total - limit} more)" if total > limit else ""
    return "; ".join(items[:limit]) + more


def _schema_errors(e: ValidationError) -> list[str]:
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


def _compare(prog: Any, ref: Any, path: str, count_bad: list[str], share_bad: list[str]) -> None:
    """Walk two structurally identical docs; ints must be equal, floats within tolerance."""
    if isinstance(ref, dict):
        for k in ref:
            _compare(prog.get(k), ref[k], _path(path, k), count_bad, share_bad)
    elif isinstance(ref, list):
        for i, (p, r) in enumerate(zip(prog, ref)):
            _compare(p, r, _path(path, i), count_bad, share_bad)
    elif isinstance(ref, bool) or isinstance(ref, str):
        return
    elif isinstance(ref, int):
        if prog != ref:
            count_bad.append(f"{path} differs from the reference")
    elif ref is None:
        if prog is not None:
            share_bad.append(f"{path} should be null (no conversations)")
    elif isinstance(ref, float):
        if prog is None or abs(float(prog) - ref) > SHARE_TOL:
            share_bad.append(f"{path} is off by more than 1e-4")


def _order_key(intent: str, cat_ids: set[str], other_ids: frozenset[str] = DEFAULT_OTHER):
    """The ordering rule. usage/friction: metric desc, then cluster_id asc — except the catch-all
    leaf (cl_other / is_other), which is always last."""
    if intent == "usage":
        return lambda r: (r["cluster_id"] in other_ids, -r["conversations"], r["cluster_id"])
    if intent == "friction":
        return lambda r: (r["cluster_id"] in other_ids, -r["friction_conversations"], r["cluster_id"])
    return lambda n: (0 if n["id"] in cat_ids else 1, n["id"])


def check(output: str | None, *, intent: str, snapshot_id: str, leaf_ids: list[str], category_ids: list[str],
          reference: dict, other_ids: frozenset[str] | set[str] = DEFAULT_OTHER) -> Verdict:
    """Validate one sandbox output against the contract and the trusted reference."""
    v = Verdict(passed=False)

    def add(name: str, ok: bool, detail: str) -> bool:
        v.checks.append(Check(name, ok, detail))
        return ok

    if intent not in INTENTS:
        raise ValueError("unknown intent")
    if not add(C_OUTPUT, output is not None, "a result file was produced" if output is not None else "the job produced no result file"):
        return v
    size = len(output.encode("utf-8"))
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

    allowed_strings = {*INTENTS, snapshot_id, *leaf_ids, *category_ids}
    bad_fields, bad_strings = _Diag(), _Diag()
    _walk(doc, allowed_strings, bad_fields, bad_strings)
    add(C_FIELDS, not bad_fields, _summarize(bad_fields) if bad_fields else "all field names are in the schema")
    add(C_STRINGS, not bad_strings, _summarize(bad_strings) if bad_strings else "only intent, snapshot and cluster ids")

    model = MODELS[intent]
    rows_key = "nodes" if intent == "aggregate" else "rows"
    try:
        if isinstance(doc.get(rows_key), list) and len(doc[rows_key]) > MAX_ROWS:
            raise _Reject(f"{rows_key} has more than {MAX_ROWS} entries")
        parsed = model.model_validate(doc)
        add(C_SCHEMA, True, f"{intent} result schema, no extra fields")
    except _Reject as e:
        add(C_SCHEMA, False, e.detail)
        return v
    except ValidationError as e:
        add(C_SCHEMA, False, _summarize(_schema_errors(e)))
        return v

    prog = parsed.model_dump()
    add(C_INTENT, prog["intent"] == intent, "matches" if prog["intent"] == intent else "the result names a different intent")
    add(C_SNAPSHOT, prog["snapshot_id"] == snapshot_id,
        "matches" if prog["snapshot_id"] == snapshot_id else "the result names a different snapshot")

    items = prog[rows_key]
    id_key = "id" if intent == "aggregate" else "cluster_id"
    expected = set(leaf_ids) | (set(category_ids) if intent == "aggregate" else set())
    ids = [r[id_key] for r in items]
    foreign = [f"{rows_key}[{i}] is not a {'node' if intent == 'aggregate' else 'leaf'} of this snapshot"
               for i, x in enumerate(ids) if x not in expected]
    add(C_IDS, not foreign, _summarize(foreign) if foreign else f"{len(ids)} ids, all from this snapshot")

    negative = [f"{p} is negative" for p, n in _ints(prog) if n < 0]
    add(C_NONNEG, not negative, _summarize(negative) if negative else "ok")

    missing = len(expected - set(ids))
    dupes = len(ids) - len(set(ids))
    cov_ok = missing == 0 and dupes == 0 and not foreign
    cov_detail = f"{len(expected)} of {len(expected)} present once" if cov_ok else \
        ", ".join(x for x in [f"{missing} missing" if missing else "", f"{dupes} duplicated" if dupes else "",
                              "unknown ids present" if foreign else ""] if x)
    add(C_COVERAGE_AGG if intent == "aggregate" else C_COVERAGE, cov_ok, cov_detail)

    add(C_TOTAL, prog["total_conversations"] == reference["total_conversations"],
        "matches" if prog["total_conversations"] == reference["total_conversations"] else "total_conversations differs from the reference")

    if cov_ok:
        ref_items = {r[id_key]: r for r in reference[rows_key]}
        count_bad: list[str] = []
        share_bad: list[str] = []
        for i, r in enumerate(items):
            _compare(r, ref_items[r[id_key]], f"{rows_key}[{i}]", count_bad, share_bad)
        if intent == "aggregate":
            _compare(prog["totals"], reference["totals"], "totals", count_bad, share_bad)
        add(C_COUNTS, not count_bad, _summarize(count_bad) if count_bad else "every integer equals the reference")
        add(C_SHARES, not share_bad, _summarize(share_bad) if share_bad else "every share within 1e-4")

    key = _order_key(intent, set(category_ids), frozenset(other_ids))
    ordered = [r[id_key] for r in sorted(items, key=key)] == ids
    first_bad = next((i for i, (a, b) in enumerate(zip(ids, [r[id_key] for r in sorted(items, key=key)])) if a != b), None)
    add(C_ORDER[intent], ordered, "ok" if ordered else f"{rows_key}[{first_bad}] is out of order")

    v.passed = all(c.passed for c in v.checks)
    if v.passed:
        v.canonical = rounded(reference)
    return v
