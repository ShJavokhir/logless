"""Pydantic models mirroring the TypeScript contracts in docs/CONTRACTS.md §5–§6.

They are used to validate what the allowlist serializers build (extra fields forbidden), and to
parse request bodies. Browser payloads are always built field by field in serializers.py."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Signal = Literal["correction", "repeat_request", "assistant_limit", "complaint"]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Signals(_Out):
    correction: int
    repeat_request: int
    assistant_limit: int
    complaint: int


class Friction(_Out):
    conversations: int
    share: float | None
    unclear: int
    signals: Signals


class Language(_Out):
    name: str
    conversations: int


class Metrics(_Out):
    conversations: int
    users: int
    share: float
    friction: Friction
    languages: list[Language]


class Need(_Out):
    id: str
    text: str


class Problem(_Out):
    id: str
    text: str
    signal: Signal | None
    support: Literal["observed", "common"]


class Surprising(_Out):
    flag: bool
    score: float


class Node(Metrics):
    id: str
    level: Literal[1, 2]
    parent_id: str | None
    title: str
    short_title: str = Field(max_length=24)   # always served; defaults to the title shortened to 24 chars
    description: str
    children: list[str] | None = None
    needs: list[Need] | None = None
    problems: list[Problem] | None = None
    surprising: Surprising | None = None
    is_other: bool | None = None


class Workspace(_Out):
    name: str
    description: str


class Fixtures(_Out):
    canary_conversations: int
    injection_conversations: int = 0


class Dataset(_Out):
    name: str
    source_url: str
    revision: str
    license: str
    attribution: str
    period_start: str
    period_end: str
    conversations: int
    users: int
    languages: int
    sample_note: str
    fixtures: Fixtures


class ProvenanceStage(_Out):
    stage: str
    started_at: str
    finished_at: str
    counts: dict[str, int]
    models: list[str]


class Provenance(_Out):
    pipeline_version: str
    dataset_hash: str
    models: dict[str, str]
    prompt_versions: dict[str, str]
    discovery_rounds: int
    build_seconds: float
    stats_source: Literal["sandbox", "local-reference"] = "local-reference"
    stages: list[ProvenanceStage]


class Snapshot(_Out):
    snapshot_id: str
    created_at: str
    workspace: Workspace
    dataset: Dataset
    totals: Metrics
    categories: list[Node]
    clusters: list[Node]
    intended_uses: list[str]
    provenance: Provenance


# ---------------------------------------------------------------- runs

class Stage(_Out):
    name: str
    status: Literal["pending", "running", "done", "failed", "skipped"]
    started_at: str | None
    finished_at: str | None
    detail: str | None


class Limits(_Out):
    cpus: float
    memory_mb: int
    pids: int
    timeout_s: float
    network: Literal["none"]
    read_only_root: Literal[True]


class Receipt(_Out):
    job_id: str
    runtime: str
    image: str
    code_sha256: str
    exit_code: int | None
    elapsed_ms: int
    timed_out: bool
    output_bytes: int
    container_removed: bool
    limits: Limits
    started_at: str
    finished_at: str
    host: str


class Check(_Out):
    name: str
    passed: bool
    detail: str


class Verdict(_Out):
    passed: bool
    checks: list[Check]


class UsageRow(_Out):
    cluster_id: str
    conversations: int
    users: int
    share: float


class FrictionRow(_Out):
    cluster_id: str
    conversations: int
    friction_conversations: int
    friction_share: float
    correction: int
    repeat_request: int
    assistant_limit: int
    complaint: int
    unclear: int


class UsageResult(_Out):
    intent: Literal["usage"]
    snapshot_id: str
    total_conversations: int
    rows: list[UsageRow]


class FrictionResult(_Out):
    intent: Literal["friction"]
    snapshot_id: str
    total_conversations: int
    rows: list[FrictionRow]


class Explanation(_Out):
    text: str
    metric_refs: list[str]


class Containment(_Out):
    deadline_ms: int
    elapsed_ms: int
    killed: bool
    container_removed: bool
    app_health: Literal["ok", "degraded"]
    followup_passed: bool
    leak_attempt_rejected: bool
    leak_rejection_checks: list[str]


class Error(_Out):
    code: str
    message: str


class Run(_Out):
    run_id: str
    kind: Literal["analysis", "story", "containment"]
    intent: Literal["usage", "friction"] | None
    snapshot_id: str
    state: Literal["queued", "planning", "executing", "validating", "repairing", "explaining", "completed", "failed"]
    created_at: str
    updated_at: str
    stages: list[Stage]
    attempts: int
    code: str | None
    receipt: Receipt | None
    verdict: Verdict | None
    result: UsageResult | FrictionResult | None
    explanation: Explanation | None
    containment: Containment | None
    error: Error | None


class Story(_Out):
    cluster_id: str
    snapshot_id: str
    label: str
    first_name: str
    text: str
    citations: list[str]
    model: str
    generated_at: str


class EvalCheck(_Out):
    id: str
    name: str
    value: str
    target: str
    passed: bool | None
    detail: str


class EvalReport(_Out):
    snapshot_id: str
    generated_at: str
    checks: list[EvalCheck]


# ---------------------------------------------------------------- requests

class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=400)


class SearchIn(_In):
    query: str = Field(min_length=1, max_length=200)
    snapshot_id: str = Field(max_length=40)


class AnalysisIn(_In):
    intent: Literal["usage", "friction"]
    snapshot_id: str = Field(max_length=40)


class StoryIn(_In):
    snapshot_id: str = Field(max_length=40)


class ContainmentIn(_In):
    pass
