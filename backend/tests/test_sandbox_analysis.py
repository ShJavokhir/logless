"""Live analysis loop with a mocked GLM and a fake runner; containment; fixed sandbox tasks."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from logless.providers import glm
from logless.sandbox import analysis, gate, reference
from logless.sandbox.aggregate import TASKS_DIR
from logless.sandbox.client import JobResult
from logless.sandbox.containment import run_containment
from logless.sandbox.export import SandboxInputs, public_structure
from logless.sandbox.runs import Run, load

from sandbox_helpers import CATS, CLUSTERS, LEAVES, SNAP, make_df, tmp_data  # noqa: F401

TITLES = {"cl_111111": "Planning trips", "cl_222222": "Fixing code", "cl_333333": "Writing emails", "cl_other": "Other"}


def inputs() -> SandboxInputs:
    df = make_df()
    structure = public_structure(CLUSTERS)
    return SandboxInputs(assignments_csv=df.to_csv(index=False), clusters_json=json.dumps(structure), df=df, mapping={},
                         clusters=structure, leaf_ids=LEAVES, category_ids=CATS)


def job(state="succeeded", output=None, stderr="", error=None, elapsed=1234, timed_out=False):
    return JobResult({"job_id": "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", "kind": "analysis", "state": state, "exit_code": 0 if state == "succeeded" else 1,
                      "started_at": "2026-09-26T00:00:00.000Z", "finished_at": "2026-09-26T00:00:01.234Z",
                      "elapsed_ms": elapsed, "timed_out": timed_out, "container_removed": True, "runtime": "runsc",
                      "image": "logless-analysis:1@sha256:ab", "output": output, "output_bytes": len(output or ""),
                      "stderr_tail": stderr, "error": error, "host": "logless-sandbox", "code_sha256": "x" * 64,
                      "limits": {"cpus": 1, "memory_mb": 512, "pids": 64, "timeout_s": 10.0, "network": "none", "read_only_root": True}})


class FakeRunner:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def run(self, **kw):
        self.calls.append(kw)
        r = self.results.pop(0)
        return r(kw) if callable(r) else r


class FakeGLM:
    def __init__(self, codes, explanations=('{{rows.0.cluster_id}} leads with {{rows[0].conversations}} conversations. It is ahead of {{rows.1.cluster_id}}.',)):
        self.codes = list(codes)
        self.explanations = list(explanations)
        self.messages = []

    def chat(self, messages, **kw):
        self.messages.append(messages)
        assert kw.get("use_cache") is False  # fresh code every run
        return f"Here you go:\n```python\n{self.codes.pop(0)}\n```\n", {"model": "glm-5.3"}

    def chat_json(self, system, user, schema, **kw):
        return schema(text=self.explanations.pop(0) if self.explanations else "{{rows.0.cluster_id}} leads."), {"model": "glm-5.3"}


@pytest.fixture()
def fake_glm(monkeypatch):
    def make(codes, **kw):
        f = FakeGLM(codes, **kw)
        monkeypatch.setattr(glm, "chat", f.chat)
        monkeypatch.setattr(glm, "chat_json", f.chat_json)
        return f
    return make


GOOD_CODE = "import json\nimport pandas as pd\ndf = pd.read_csv('/in/assignments.csv')\njson.dump({}, open('/out/result.json', 'w'))"


def good_output(intent, inp):
    fn = reference.usage if intent == "usage" else reference.friction
    return json.dumps(reference.rounded(fn(inp.df, LEAVES, SNAP)))


def statuses(doc):
    return [(s["name"], s["status"]) for s in doc["stages"]]


@pytest.mark.parametrize("intent", ["usage", "friction"])
def test_success_first_try(tmp_data, fake_glm, intent):
    inp = inputs()
    g = fake_glm([GOOD_CODE])
    runner = FakeRunner([job(output=good_output(intent, inp))])
    run = Run.create("analysis", intent, SNAP)
    analysis.run_analysis(run, intent=intent, snapshot_id=SNAP, titles=TITLES, runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed", doc["error"]
    assert doc["attempts"] == 1 and doc["verdict"]["passed"] is True
    assert doc["result"] == reference.rounded((reference.usage if intent == "usage" else reference.friction)(inp.df, LEAVES, SNAP))
    assert statuses(doc) == [("planning", "done"), ("executing", "done"), ("validating", "done"), ("explaining", "done")]
    assert all(s["started_at"] for s in doc["stages"] if s["status"] == "done")
    # placeholders are paths into the result; bracket indexes are normalized to dots
    assert doc["explanation"] == {"text": "{{rows.0.cluster_id}} leads with {{rows.0.conversations}} conversations. It is ahead of {{rows.1.cluster_id}}.",
                                  "metric_refs": ["rows.0.cluster_id", "rows.0.conversations", "rows.1.cluster_id"]}
    assert doc["receipt"]["runtime"] == "runsc" and doc["receipt"]["container_removed"] is True
    assert "stderr_tail" not in json.dumps(doc) and "output" not in doc["receipt"]
    # GLM never sees rows: the prompt holds the data dictionary, not data
    prompt = json.dumps(g.messages[0])
    assert "assignments.csv" in prompt and inp.assignments_csv.splitlines()[1] not in prompt
    files = runner.calls[0]["files"]
    assert set(files) == {"assignments.csv", "clusters.json", "contract.json"} and json.loads(files["contract.json"])["intent"] == intent


def test_failure_then_repair_succeeds(tmp_data, fake_glm):
    inp = inputs()
    g = fake_glm([GOOD_CODE, GOOD_CODE + "\n# fixed"])
    secret = "SECRET_VALUE_4242"
    runner = FakeRunner([job(state="failed", error="nonzero_exit", stderr=f"Traceback (most recent call last):\n  File x\nKeyError: '{secret}'\n"),
                         job(output=good_output("usage", inp))])
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed" and doc["attempts"] == 2
    assert statuses(doc) == [("planning", "done"), ("executing", "failed"), ("validating", "skipped"), ("repairing", "done"),
                             ("executing", "done"), ("validating", "done"), ("explaining", "done")]
    repair_prompt = g.messages[1][-1]["content"]
    assert "KeyError: the program used a column or key that does not exist" in repair_prompt
    assert secret not in json.dumps(g.messages) and secret not in json.dumps(doc)
    assert doc["code"].endswith("# fixed\n")


def test_gate_failure_repair_prompt_has_only_check_names(tmp_data, fake_glm):
    inp = inputs()
    g = fake_glm([GOOD_CODE, GOOD_CODE])
    leak = json.loads(good_output("usage", inp))
    leak["rows"][0]["user"] = 777777
    runner = FakeRunner([job(output=json.dumps(leak)), job(output=good_output("usage", inp))])
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed" and doc["attempts"] == 2
    repair_prompt = g.messages[1][-1]["content"]
    assert "Gate check failed: Only allowlisted field names" in repair_prompt
    assert "777777" not in json.dumps(g.messages) and "777777" not in json.dumps(doc)


def test_two_failures_fail_honestly(tmp_data, fake_glm):
    inp = inputs()
    fake_glm([GOOD_CODE, GOOD_CODE])
    bad = json.loads(good_output("usage", inp))
    bad["rows"].reverse()
    runner = FakeRunner([job(state="timed_out", error="timeout", timed_out=True, elapsed=10050), job(output=json.dumps(bad))])
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "failed" and doc["error"]["code"] == "analysis_failed"
    assert doc["result"] is None and doc["explanation"] is None and doc["attempts"] == 2
    assert doc["verdict"]["passed"] is False
    assert statuses(doc) == [("planning", "done"), ("executing", "failed"), ("validating", "skipped"), ("repairing", "done"),
                             ("executing", "done"), ("validating", "failed"), ("explaining", "skipped")]
    assert "killed at the 10 s limit" in doc["stages"][1]["detail"]


def test_static_precheck_blocks_execution(tmp_data, fake_glm):
    inp = inputs()
    g = fake_glm(["import os\nos.system('curl example.com')", GOOD_CODE])
    runner = FakeRunner([job(output=good_output("usage", inp))])
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed" and doc["attempts"] == 1 and len(runner.calls) == 1
    assert statuses(doc)[1] == ("executing", "failed") and statuses(doc)[4] == ("executing", "done")
    assert "Static check: import of 'os' is not allowed" in g.messages[1][-1]["content"]


def test_runner_unreachable(tmp_data, fake_glm):
    from logless.sandbox.client import SandboxUnavailable
    fake_glm([GOOD_CODE])

    def boom(_):
        raise SandboxUnavailable("ConnectError")
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=FakeRunner([boom]), inputs=inputs())
    doc = load(run.id)
    assert doc["state"] == "failed" and doc["error"]["code"] == "sandbox_unavailable"


def test_explanation_with_digits_falls_back_to_template(tmp_data, fake_glm):
    inp = inputs()
    fake_glm([GOOD_CODE], explanations=["Trips lead with 48 conversations.", "{{rows.0.cluster_id}} is most of {{bogus}}."])
    run = Run.create("analysis", "usage", SNAP)
    analysis.run_analysis(run, intent="usage", snapshot_id=SNAP, titles=TITLES, runner=FakeRunner([job(output=good_output("usage", inp))]), inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed"
    assert doc["explanation"]["text"] == analysis.fallback_explanation("usage", doc["result"])
    assert "fixed template" in doc["stages"][-1]["detail"]
    assert set(doc["explanation"]["metric_refs"]) <= analysis.result_paths(doc["result"])


def test_validate_explanation():
    result = reference.rounded(reference.usage(make_df(), LEAVES, SNAP))
    vocab = analysis.result_paths(result)
    assert "rows.3.share" in vocab and "rows.4.share" not in vocab and "intent" not in vocab
    assert analysis.validate_explanation("{{rows.0.cluster_id}} leads at {{rows.0.share}}.", vocab) == []
    assert analysis.validate_explanation("{{ rows[1].cluster_id }} is next.", vocab) == []
    assert any("digits" in p for p in analysis.validate_explanation("{{rows.0.cluster_id}} has 5 users.", vocab))
    assert any("quantity" in p for p in analysis.validate_explanation("{{rows.0.cluster_id}} is about half.", vocab))
    assert any("do not resolve" in p for p in analysis.validate_explanation("{{rows.9.cluster_id}} {{top1.title}}", vocab))
    assert any("placeholder" in p for p in analysis.validate_explanation("No numbers here.", vocab))
    assert analysis.normalize_text("{{ rows[2].users }}") == "{{rows.2.users}}"


def test_extract_code():
    assert analysis.extract_code("```python\nprint(1)\n```") == "print(1)\n"
    assert analysis.extract_code("text\n```py\na=1\n```\nmore\n```python\nb=2\nc=3\n```") == "b=2\nc=3\n"
    assert analysis.extract_code("```Python\nx=1\n") == "x=1\n"          # unclosed fence
    assert analysis.extract_code("x = 1\n") == "x = 1\n"
    assert analysis.extract_code("```\ny=2\n```") == "y=2\n"


def test_precheck():
    assert analysis.precheck(GOOD_CODE) == []
    assert analysis.precheck("import pandas as pd\nfrom collections import Counter\nimport numpy.linalg") == []
    assert "import of 'subprocess' is not allowed" in analysis.precheck("import subprocess")
    assert "import from 'os' is not allowed" in analysis.precheck("from os import path")
    assert "call to 'eval' is not allowed" in analysis.precheck("eval('1')")
    assert "dunder attribute '__class__' is not allowed" in analysis.precheck("x = ().__class__")
    assert "path '/etc/passwd' is not allowed" in analysis.precheck("open('/etc/passwd')")
    assert analysis.precheck("def f(:\n")[0].startswith("SyntaxError")


def test_error_category_is_fixed_vocabulary():
    assert analysis.error_category("failed", "nonzero_exit", "Traceback\n  File\nKeyError: 'cl_x'\n").startswith("KeyError:")
    assert analysis.error_category("failed", "nonzero_exit", "x\npandas.errors.MergeError: bad\n").startswith("pandas MergeError")
    assert analysis.error_category("failed", "nonzero_exit", "x\nLeakError: alice smith\n") == "runtime error"
    assert analysis.error_category("failed", "nonzero_exit", "user 17 had 4 complaints\n") == "runtime error"
    assert analysis.error_category("timed_out", "timeout", "").startswith("Timeout")
    assert analysis.error_category("failed", "no_output", "").startswith("NoOutput")


# ---------------------------------------------------------------- fixed tasks, executed locally

def run_task_locally(tmp_path: Path, name: str, inp: SandboxInputs, intent: str) -> str:
    """Execute a sandbox task on this machine with /in and /out rewritten to temp dirs (no docker)."""
    d_in, d_out = tmp_path / "in", tmp_path / "out"
    d_in.mkdir(exist_ok=True)
    d_out.mkdir(exist_ok=True)
    for k, v in inp.files(analysis.output_contract(intent, SNAP)).items():
        (d_in / k).write_text(v)
    src = (TASKS_DIR / name).read_text().replace("/in/", f"{d_in}/").replace("/out/", f"{d_out}/")
    subprocess.run([sys.executable, "-c", src], check=True, timeout=60, env={**os.environ})
    return (d_out / "result.json").read_text()


def test_fixed_tasks_against_gate(tmp_path):
    inp = inputs()
    out = run_task_locally(tmp_path, "aggregate.py", inp, "aggregate")
    v = gate.check(out, intent="aggregate", snapshot_id=SNAP, leaf_ids=LEAVES, category_ids=CATS,
                   reference=reference.aggregate(inp.df, CLUSTERS, SNAP))
    assert v.passed, v.public()
    out = run_task_locally(tmp_path, "usage.py", inp, "usage")
    v = gate.check(out, intent="usage", snapshot_id=SNAP, leaf_ids=LEAVES, category_ids=CATS,
                   reference=reference.usage(inp.df, LEAVES, SNAP))
    assert v.passed, v.public()
    out = run_task_locally(tmp_path, "leak_attempt.py", inp, "friction")
    v = gate.check(out, intent="friction", snapshot_id=SNAP, leaf_ids=LEAVES, category_ids=CATS,
                   reference=reference.friction(inp.df, LEAVES, SNAP))
    assert not v.passed and gate.C_FIELDS in v.failed_names and gate.C_SCHEMA in v.failed_names
    assert "unknown field 'user' in rows[0]" in next(c.detail for c in v.checks if c.name == gate.C_FIELDS)


def test_containment_flow(tmp_data, tmp_path):
    inp = inputs()
    usage_out = run_task_locally(tmp_path / "u", "usage.py", inp, "usage") if (tmp_path / "u").mkdir() is None else None
    leak_out = run_task_locally(tmp_path / "l", "leak_attempt.py", inp, "friction") if (tmp_path / "l").mkdir() is None else None
    runner = FakeRunner([job(state="timed_out", error="timeout", timed_out=True, elapsed=2104),
                         job(output=usage_out), job(output=leak_out)])
    run = Run.create("containment", None, SNAP)
    run_containment(run, snapshot_id=SNAP, health=lambda: "ok", runner=runner, inputs=inp)
    doc = load(run.id)
    assert doc["state"] == "completed", doc
    c = doc["containment"]
    assert c == {"deadline_ms": 2000, "elapsed_ms": 2104, "killed": True, "container_removed": True, "app_health": "ok",
                 "followup_passed": True, "leak_attempt_rejected": True,
                 "leak_rejection_checks": [gate.C_FIELDS, gate.C_SCHEMA]}
    assert runner.calls[0]["timeout_s"] == 2.0 and "while True" in runner.calls[0]["code"]
    assert "Execution limit reached" in doc["stages"][0]["detail"]
    assert doc["result"] is None and doc["verdict"]["passed"] is False
