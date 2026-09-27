"""Live questions: "What are people doing?" (usage) and "What's not working?" (friction).

State machine (docs/CONTRACTS.md §6):
  planning → executing → validating → (repairing → executing → validating) → explaining → completed | failed

- GLM 5.3 gets ONLY the intent, the data dictionary, the output contract and the ordering rule —
  never rows — and writes a pandas program.
- A static pre-check rejects obviously out-of-bounds programs (best effort; the container is the
  real boundary).
- The program runs once in a fresh sandbox container; its output must pass the egress gate.
- One repair attempt. The repair prompt contains no sandbox-authored text: only the failed gate
  check names and a trusted error category derived from the exception type.
- GLM writes a two-sentence explanation with {{placeholders}}; the backend resolves them from the
  validated (reference) result, so no number shown to a PM comes from a model.
"""
from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
from typing import Callable

from pydantic import BaseModel

from ..providers import glm
from ..providers.http import ProviderError
from . import gate, reference
from .client import RUNNER_ERRORS, RunnerClient, SandboxInvalidResponse, SandboxUnavailable, receipt
from .export import SIGNALS, SandboxInputs, export_inputs, load_cluster_map
from .runs import Run

log = logging.getLogger("logless.sandbox")

ANALYSIS_TIMEOUT_S = 10.0
MAX_EXECUTIONS = 2
ALLOWED_IMPORTS = {"pandas", "numpy", "json", "math", "collections", "pathlib", "csv"}
ALLOWED_PATHS = {"/in/assignments.csv", "/in/clusters.json", "/in/contract.json", "/out/result.json", "/in", "/in/", "/out", "/out/", "/tmp", "/tmp/"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "globals", "locals", "vars", "breakpoint", "input",
                "getattr", "setattr", "delattr", "memoryview"}
BANNED_NAMES = {"__builtins__", "__loader__", "__spec__", "__import__"}

# ---------------------------------------------------------------- contract given to the model

DATA_DICTIONARY = """\
/in/assignments.csv — CSV with a header row; one row per conversation. Columns:
  row              int  per-job random row number (not meaningful)
  user             int  per-job pseudonymous person number (count distinct values; never output them)
  leaf_id          str  the leaf cluster of the conversation, e.g. "cl_3fa2b1" or "cl_other"
  category_id      str  the parent category of that leaf, e.g. "cat_91be0c"
  correction       str  one of "observed", "not_observed", "unclear"
  repeat_request   str  one of "observed", "not_observed", "unclear"
  assistant_limit  str  one of "observed", "not_observed", "unclear"
  complaint        str  one of "observed", "not_observed", "unclear"
/in/clusters.json — JSON list of {"id": str, "parent_id": str or null, "level": 1 or 2, "is_other": bool}.
  level 2 = leaf clusters (every leaf must appear in the output, including leaves with zero conversations);
  level 1 = categories.
/in/contract.json — JSON object with "intent", "snapshot_id", "output_path", "fields", "ordering", "rules".
"""

FIELDS = {
    "usage": {
        "intent": '"usage"',
        "snapshot_id": "copy from /in/contract.json",
        "total_conversations": "int: number of rows in assignments.csv",
        "rows": "list, one object per leaf cluster (level 2) with exactly these keys:",
        "rows[].cluster_id": "str: the leaf id",
        "rows[].conversations": "int: rows with this leaf_id",
        "rows[].users": "int: distinct `user` values among those rows",
        "rows[].share": "float: conversations / total_conversations rounded to 4 decimals (0.0 if total is 0)",
    },
    "friction": {
        "intent": '"friction"',
        "snapshot_id": "copy from /in/contract.json",
        "total_conversations": "int: number of rows in assignments.csv",
        "rows": "list, one object per leaf cluster (level 2) with exactly these keys:",
        "rows[].cluster_id": "str: the leaf id",
        "rows[].conversations": "int: rows with this leaf_id",
        "rows[].friction_conversations": "int: rows where at least one of the four signal columns == \"observed\"",
        "rows[].friction_share": "float: friction_conversations / conversations rounded to 4 decimals (0.0 if conversations is 0)",
        "rows[].correction": "int: rows where correction == \"observed\"",
        "rows[].repeat_request": "int: rows where repeat_request == \"observed\"",
        "rows[].assistant_limit": "int: rows where assistant_limit == \"observed\"",
        "rows[].complaint": "int: rows where complaint == \"observed\"",
        "rows[].unclear": "int: rows with no \"observed\" signal and at least one \"unclear\" signal",
    },
    "aggregate": {
        "intent": '"aggregate"',
        "snapshot_id": "copy from /in/contract.json",
        "total_conversations": "int",
        "totals": "metrics over all rows",
        "nodes": "list: every category, then every leaf; each {id, conversations, users, share, friction: {conversations, share, unclear, signals: {correction, repeat_request, assistant_limit, complaint}}}",
    },
}
ORDERING = {
    "usage": "rows sorted by conversations descending, then cluster_id ascending, except that the catch-all leaf "
             "(the level-2 cluster with is_other true in clusters.json) is always the last row",
    "friction": "rows sorted by friction_conversations descending, then cluster_id ascending, except that the catch-all "
                "leaf (the level-2 cluster with is_other true in clusters.json) is always the last row",
    "aggregate": "nodes: categories by id ascending, then leaves by id ascending",
}
RULES = [
    "Write exactly one file, /out/result.json, containing one JSON object and nothing else (use json.dump).",
    "Every leaf cluster (level 2 in clusters.json) appears exactly once, including leaves with zero conversations.",
    "The catch-all leaf (is_other true) is always the last row, whatever its numbers.",
    "Use only the keys listed in fields; integers must be JSON integers (convert numpy types with int()).",
    "Output only aggregate numbers per cluster: never output row numbers, user numbers or any per-row data.",
    "Do not print data to stdout or stderr.",
]


def output_contract(intent: str, snapshot_id: str) -> dict:
    return {"intent": intent, "snapshot_id": snapshot_id, "output_path": "/out/result.json",
            "fields": FIELDS[intent], "ordering": ORDERING[intent], "rules": RULES}


INTENT_TEXT = {
    "usage": "What are people doing with the assistant? For every leaf cluster, count conversations and distinct people, and its share of all conversations.",
    "friction": "What is not working? For every leaf cluster, count conversations with observed friction, each friction signal, and unclear conversations.",
}

SYSTEM = (
    "You write one self-contained Python 3.12 program for a sandboxed analytics job. Available: pandas, numpy, and the "
    "standard modules json, math, collections, pathlib, csv. There is no network; the filesystem is read-only except "
    "/out and /tmp. The program must not import anything else, must not use eval/exec/getattr or dunder attributes, "
    "and must only open /in/assignments.csv, /in/clusters.json, /in/contract.json and /out/result.json. "
    "Reply with only the program in a single ```python fenced block."
)


def plan_prompt(intent: str, snapshot_id: str) -> str:
    return (
        f"Task: {INTENT_TEXT[intent]}\n\nData dictionary:\n{DATA_DICTIONARY}\n"
        f"Output contract (this exact object is also in /in/contract.json; read snapshot_id from there):\n"
        f"{json.dumps(output_contract(intent, snapshot_id), indent=1)}\n\n"
        f"Ordering rule: {ORDERING[intent]}.\n"
        "Keep it short and robust: read the CSV with pandas (dtype=str for the id and signal columns), take the leaf list "
        "from clusters.json, compute every number with pandas, sort, and json.dump the result."
    )


# ---------------------------------------------------------------- code handling

_FENCE = re.compile(r"```[ \t]*(?:python3?|py)?[ \t]*\r?\n(.*?)```", re.S | re.I)
_OPEN_FENCE = re.compile(r"```[ \t]*(?:python3?|py)?[ \t]*\r?\n(.*)$", re.S | re.I)


def extract_code(text: str) -> str:
    """The program from a model reply: the longest fenced block, an unclosed fence, or the raw text."""
    blocks = _FENCE.findall(text or "")
    if blocks:
        return max(blocks, key=len).strip() + "\n"
    m = _OPEN_FENCE.search(text or "")
    if m:
        return m.group(1).strip() + "\n"
    return (text or "").strip() + "\n"


def precheck(code: str) -> list[str]:
    """Best-effort static check. Returns human-readable problems (the code is model-authored and public)."""
    if len(code.encode()) > 60_000:
        return ["the program is too long"]
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"SyntaxError at line {e.lineno}"]
    problems: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split(".")[0] not in ALLOWED_IMPORTS:
                    problems.append(f"import of '{a.name}' is not allowed")
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                problems.append(f"import from '{node.module}' is not allowed")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
            problems.append(f"call to '{node.func.id}' is not allowed")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr.endswith("__"):
            problems.append(f"dunder attribute '{node.attr}' is not allowed")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            problems.append(f"name '{node.id}' is not allowed")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith("/") \
                and "\n" not in node.value and len(node.value) < 200 and node.value not in ALLOWED_PATHS:
            problems.append(f"path '{node.value}' is not allowed")
    return sorted(set(problems))[:5]


# Trusted error categories: derived from the exception TYPE only, mapped to fixed text.
ERROR_CATEGORIES = {
    "KeyError": "KeyError: the program used a column or key that does not exist",
    "ValueError": "ValueError: an invalid value or conversion",
    "TypeError": "TypeError: an operation got the wrong type (check numpy vs Python types)",
    "IndexError": "IndexError: an index was out of range",
    "AttributeError": "AttributeError: an attribute or method does not exist (check the pandas 2.2 API)",
    "NameError": "NameError: a name was used before it was defined",
    "FileNotFoundError": "FileNotFoundError: a path does not exist (inputs are /in/assignments.csv, /in/clusters.json, /in/contract.json)",
    "PermissionError": "PermissionError: writes are only allowed to /out/result.json and /tmp",
    "OSError": "OSError: a filesystem or resource error",
    "ZeroDivisionError": "ZeroDivisionError: division by zero (guard clusters with zero conversations)",
    "JSONDecodeError": "JSONDecodeError: a JSON input could not be parsed",
    "ModuleNotFoundError": "ModuleNotFoundError: only pandas, numpy and the standard library are available",
    "ImportError": "ImportError: only pandas, numpy and the standard library are available",
    "MemoryError": "MemoryError: the 512 MB memory limit was reached",
    "RecursionError": "RecursionError: recursion too deep",
    "SyntaxError": "SyntaxError: the program does not parse",
    "IndentationError": "SyntaxError: the program does not parse",
    "UnboundLocalError": "NameError: a variable was used before assignment",
    "MergeError": "pandas MergeError: an invalid merge",
    "InvalidIndexError": "pandas InvalidIndexError: an invalid index operation",
}
RUNNER_ERRORS = {
    "timeout": "Timeout: the program exceeded the 10 s limit (pandas import alone takes about 2 s)",
    "oom_killed": "MemoryError: the 512 MB memory limit was reached",
    "no_output": "NoOutput: the program exited without writing /out/result.json",
    "output_too_large": "OutputTooLarge: /out/result.json exceeded 1 MiB",
    "output_not_regular_file": "OutputNotRegularFile: /out/result.json must be a regular file",
    "too_many_output_files": "TooManyOutputFiles: write only /out/result.json",
    "not_utf8": "OutputNotUTF8: /out/result.json must be UTF-8 JSON",
}
_EXC_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?::|$)")


def error_category(res_state: str, error: str | None, stderr_tail: str) -> str:
    """A fixed message chosen by the exception type in the last traceback line. Nothing from
    stderr is passed on except that the type name matched one of our known names."""
    if res_state == "timed_out":
        return RUNNER_ERRORS["timeout"]
    if error in RUNNER_ERRORS:
        return RUNNER_ERRORS[error]
    for line in reversed([x.strip() for x in (stderr_tail or "").splitlines() if x.strip()]):
        m = _EXC_LINE.match(line)
        if m:
            name = m.group(1).rsplit(".", 1)[-1]
            return ERROR_CATEGORIES.get(name, "runtime error")
    return "runtime error"


# ---------------------------------------------------------------- explanation
#
# Placeholders are dotted paths into the validated `result` (the UI resolves them itself):
#   {{total_conversations}}, {{rows.0.cluster_id}} (rendered as the cluster title),
#   {{rows.0.conversations}}, {{rows.1.friction_share}} (any *share renders as a percentage).
# `rows[1].x` is accepted and normalized to `rows.1.x`.

class _Explanation(BaseModel):
    text: str


_PH = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
_BRACKET = re.compile(r"\[(\d+)\]")
QUANTITY_WORDS = re.compile(r"(?i)\b(half|halves|majority|minority|most of|double|twice|triple|thrice|quarter|third|dozens?|"
                            r"hundreds?|thousands?|millions?|percent|per cent|one|two|three|four|five|six|seven|eight|nine|ten)\b")
PROMPT_ROWS = 6


def normalize_path(p: str) -> str:
    return _BRACKET.sub(r".\1", p.strip()).strip(".")


def result_paths(result: dict) -> set[str]:
    """Every placeholder that resolves to a scalar in the validated result."""
    paths = {k for k, v in result.items() if not isinstance(v, (list, dict))}
    for i, row in enumerate(result.get("rows") or []):
        paths |= {f"rows.{i}.{k}" for k in row}
    return paths - {"intent", "snapshot_id"}


def normalize_text(text: str) -> str:
    return _PH.sub(lambda m: "{{" + normalize_path(m.group(1)) + "}}", text)


def validate_explanation(text: str, vocab: set[str]) -> list[str]:
    problems = []
    refs = [normalize_path(r) for r in _PH.findall(text)]
    unknown = sorted({r for r in refs if r not in vocab})
    if unknown:
        problems.append("placeholders that do not resolve in the result: " + ", ".join(unknown[:5]))
    if not refs:
        problems.append("use at least one placeholder")
    if len(refs) > 10:
        problems.append("use at most 10 placeholders")
    stripped = _PH.sub("", text)
    if re.search(r"\d", stripped):
        problems.append("the text contains digits; every number must be a placeholder")
    if QUANTITY_WORDS.search(stripped):
        problems.append("the text states a quantity in words; every quantity must be a placeholder")
    if "{" in stripped or "}" in stripped:
        problems.append("malformed placeholder braces")
    words = len(_PH.sub("X", text).split())
    if words > 55:
        problems.append(f"too long ({words} words; at most 55)")
    if len(re.findall(r"[.!?](\s|$)", text.strip())) > 2:
        problems.append("more than two sentences")
    return problems


def fallback_explanation(intent: str, result: dict) -> str:
    n = len(result.get("rows") or [])
    if intent == "usage":
        text = ("{{rows.0.cluster_id}} is the most common workflow, with {{rows.0.conversations}} of "
                "{{total_conversations}} conversations ({{rows.0.share}}).")
        if n >= 3:
            text += " {{rows.1.cluster_id}} and {{rows.2.cluster_id}} follow."
    else:
        text = ("{{rows.0.cluster_id}} has the most conversations with observed friction: "
                "{{rows.0.friction_conversations}} of {{rows.0.conversations}} ({{rows.0.friction_share}}).")
        if n >= 2:
            text += " {{rows.1.cluster_id}} follows with {{rows.1.friction_conversations}} ({{rows.1.friction_share}})."
    return text


def explain(intent: str, result: dict, titles: dict[str, str]) -> tuple[dict, str]:
    """Returns ({text, metric_refs}, source) where source is 'model' or 'template'."""
    vocab = result_paths(result)
    rows = [{"index": i, "title": titles.get(r["cluster_id"], r["cluster_id"]), **r} for i, r in enumerate(result["rows"][:PROMPT_ROWS])]
    system = (
        "You explain a finished, validated analysis to a product manager in two short sentences (at most 45 words, "
        "at most 8 placeholders). Never write a digit, a number or a quantity word (half, most, twice, one, …) and never "
        "write a cluster title yourself. Refer to values ONLY through placeholders that are paths into the result: "
        "{{total_conversations}}, {{rows.N.cluster_id}} for the name of the cluster in row N, and {{rows.N.<field>}} for "
        "its numbers (e.g. {{rows.0.conversations}}, {{rows.1.friction_share}}). Shares render as percentages. Do not "
        "add up or interpret numbers yourself and do not invent causes."
    )
    user = (f"Question: {INTENT_TEXT[intent]}\nOrdering: {ORDERING[intent]}.\n"
            f"total_conversations = {result['total_conversations']}\n"
            f"First rows of the validated result (row index, published title, fields):\n{json.dumps(rows, indent=1)}\n"
            'Return {"text": "..."}.')
    problems: list[str] = []
    for attempt in range(2):
        try:
            prompt = user if attempt == 0 else user + "\nYour previous text was rejected: " + "; ".join(problems)
            out, _ = glm.chat_json(system, prompt, _Explanation, reasoning="off", temperature=0.3, max_tokens=400, use_cache=False)
            text = normalize_text(out.text.strip())
            problems = validate_explanation(text, vocab)
            if not problems:
                return {"text": text, "metric_refs": list(dict.fromkeys(_PH.findall(text)))}, "model"
        except (glm.GLMOutputError, ProviderError):
            problems = ["no valid output"]
    text = fallback_explanation(intent, result)
    return {"text": text, "metric_refs": list(dict.fromkeys(_PH.findall(text)))}, "template"


# ---------------------------------------------------------------- the loop

def _write_code(messages: list[dict]) -> tuple[str, dict]:
    content, meta = glm.chat(messages, reasoning="low", temperature=0.2, max_tokens=4000, use_cache=False)
    return extract_code(content), meta


def _exec_detail(res, rc: dict) -> str:
    removed = "container removed" if rc["container_removed"] else "container removal NOT verified"
    if res.state == "succeeded":
        return f"exit 0 in {rc['elapsed_ms']:,} ms · {rc['runtime']} · {rc['output_bytes']:,} bytes · {removed}"
    if res.state == "timed_out":
        return f"killed at the {ANALYSIS_TIMEOUT_S:.0f} s limit after {rc['elapsed_ms']:,} ms · {removed}"
    err = res.get("error") if res.get("error") in RUNNER_ERRORS else "error"
    return f"failed ({err}, exit {rc['exit_code']}) after {rc['elapsed_ms']:,} ms · {removed}"


def load_inputs(snapshot_id: str) -> SandboxInputs:
    found = load_cluster_map(snapshot_id)
    if found is None:
        raise LookupError("no sandbox inputs are registered for this snapshot")
    build_id, clusters = found
    return export_inputs(build_id, clusters)


def run_analysis(run: Run, *, intent: str, snapshot_id: str, titles: dict[str, str],
                 runner: RunnerClient | None = None, inputs: SandboxInputs | None = None,
                 on_stage: Callable[[str], None] | None = None) -> None:
    """Drive one analysis run to completed | failed. Never raises (errors are recorded on the run)."""
    try:
        _run(run, intent, snapshot_id, titles, runner or RunnerClient(), inputs)
    except SandboxInvalidResponse:
        run.fail("sandbox_invalid_response", "The sandbox returned a malformed response, so nothing from it was used.")
    except SandboxUnavailable:
        run.fail("sandbox_unavailable", "The sandbox is unreachable right now; the saved snapshot is unaffected.")
    except LookupError:
        run.fail("no_inputs", "This snapshot has no sandbox inputs; live analysis is unavailable.")
    except ProviderError as e:
        run.fail("model_unavailable", f"The code-writing model is unavailable ({e.provider}).")
    except Exception as e:  # noqa: BLE001 — never leak a stack trace into the run
        log.error("analysis %s crashed: %s", run.id, type(e).__name__)
        run.fail("internal_error", "The analysis failed unexpectedly.")


def _run(run: Run, intent: str, snapshot_id: str, titles: dict[str, str], runner: RunnerClient, inputs: SandboxInputs | None) -> None:
    if intent not in ("usage", "friction"):
        raise ValueError("intent")
    run.state("planning")
    run.stage("planning", "running", "GLM 5.3 is writing a pandas program from the data dictionary (it never sees rows)")
    inputs = inputs or load_inputs(snapshot_id)
    ref = reference.usage(inputs.df, inputs.leaf_ids, snapshot_id, inputs.other_ids) if intent == "usage" else \
        reference.friction(inputs.df, inputs.leaf_ids, snapshot_id, inputs.other_ids)
    contract = output_contract(intent, snapshot_id)
    files = inputs.files(contract)

    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": plan_prompt(intent, snapshot_id)}]
    code, meta = _write_code(messages)
    run.update(code=code)
    problems = precheck(code)
    run.stage("planning", "done", f"{meta.get('model', glm.GLM)} wrote a {len(code.strip().splitlines())}-line program"
              + (f"; static check: {problems[0]}" if problems else "; static check passed"))

    result = None
    executions = 0
    for attempt in (1, 2):
        feedback: list[str] = []
        if problems:
            run.stage("executing", "failed", "not run: the static check rejected the program")
            run.stage("validating", "skipped")
            feedback = [f"Static check: {p}" for p in problems]
        else:
            run.state("executing")
            run.stage("executing", "running", ("attempt 2 · " if attempt == 2 else "")
                      + "fresh gVisor container · no network · read-only inputs · 10 s limit")
            run.update(verdict=None)
            res = runner.run(kind="analysis", code=code, files=files, timeout_s=ANALYSIS_TIMEOUT_S)
            rc = receipt(res, hashlib.sha256(code.encode()).hexdigest(), timeout_s=ANALYSIS_TIMEOUT_S)
            executions += 1
            run.update(receipt=rc, attempts=executions)
            if res.state != "succeeded":
                run.stage("executing", "failed", _exec_detail(res, rc))
                run.stage("validating", "skipped")
                feedback = [error_category(res.state, res.get("error"), res.stderr_tail)]
            else:
                run.stage("executing", "done", _exec_detail(res, rc))
                run.state("validating")
                run.stage("validating", "running", "egress gate: schema, allowlist, reference equality, ordering")
                verdict = gate.check(res.output, intent=intent, snapshot_id=snapshot_id, leaf_ids=inputs.leaf_ids,
                                     category_ids=inputs.category_ids, reference=ref, other_ids=inputs.other_ids)
                run.update(verdict=verdict.public())
                n_ok = sum(c.passed for c in verdict.checks)
                if verdict.passed:
                    run.stage("validating", "done", f"passed {n_ok}/{len(verdict.checks)} checks")
                    result = verdict.canonical
                    break
                run.stage("validating", "failed", f"rejected: {', '.join(verdict.failed_names)}")
                feedback = [f"Gate check failed: {name}" for name in verdict.failed_names]
        if attempt == 1:
            # One repair round: a new repairing → executing → validating sequence before explaining.
            run.insert_stages(["repairing", "executing", "validating"], before="explaining")
            run.state("repairing")
            run.stage("repairing", "running", "GLM 5.3 gets only the failed check names / a fixed error category")
            repair = ("The program did not pass. Problems:\n- " + "\n- ".join(feedback) +
                      "\nReturn the complete corrected program in one ```python block.")
            messages = messages[:2] + [{"role": "assistant", "content": f"```python\n{code}```"}, {"role": "user", "content": repair}]
            code, meta = _write_code(messages)
            run.update(code=code)
            problems = precheck(code)
            run.stage("repairing", "done", f"new {len(code.strip().splitlines())}-line program"
                      + (f"; static check: {problems[0]}" if problems else "; static check passed"))

    if result is None:
        run.fail("analysis_failed", "The generated program did not produce a valid result after one repair attempt. "
                                    "Nothing from its output was used.")
        return

    run.update(result=result)
    run.state("explaining")
    run.stage("explaining", "running", "GLM 5.3 writes two sentences with placeholders; the UI fills them from the validated result")
    explanation, source = explain(intent, result, titles)
    run.update(explanation=explanation)
    run.stage("explaining", "done", "model text validated (placeholders only, no digits)" if source == "model"
              else "model text failed validation; used the fixed template")
    run.complete()
