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


class Care(_Out):
    refusal: int
    sensitive: int
    unclear: int


class Concentration(_Out):
    top_people_share: float | None
    conversations_per_person: float | None


class Language(_Out):
    name: str
    conversations: int


class Metrics(_Out):
    conversations: int
    users: int
    share: float
    friction: Friction
    care: Care | None = None   # absent on snapshots published before care signals existed
    concentration: Concentration | None = None   # absent on snapshots published before it existed
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


class Plan(_Out):
    group_by: Literal["leaf", "category", "subtheme"]
    scope_category_id: str | None
    scope_leaf_id: str | None = None
    measure: Literal["conversations", "people"]
    signal: Literal["any_friction", "correction", "repeat_request", "assistant_limit", "complaint"] | None
    rank_by: Literal["count", "share"]
    limit: int = Field(ge=1, le=10)


class QuestionRow(_Out):
    id: str
    count: int
    base: int
    share: float


class QuestionResult(_Out):
    intent: Literal["question"]
    snapshot_id: str
    plan: Plan
    rows: list[QuestionRow]
    total_count: int
    total_base: int


class Attempt(_Out):
    attempt: Literal[1, 2]
    program: Literal["A", "B"]
    code: str
    code_sha256: str
    receipt: Receipt | None          # null only when the static pre-check rejected the program (not executed)
    verdict: Verdict
    repair_reason: str | None


class Explanation(_Out):
    text: str
    metric_refs: list[str]


class Destructive(_Out):
    command: str
    exit_code: int | None
    refused: int | None
    container_removed: bool
    root_read_only: bool | None
    binaries_intact: bool | None
    next_run_clean: bool
    contained: bool


class Containment(_Out):
    deadline_ms: int
    elapsed_ms: int
    killed: bool
    container_removed: bool
    app_health: Literal["ok", "degraded"]
    destructive: Destructive | None
    followup_passed: bool
    leak_attempt_rejected: bool
    leak_rejection_checks: list[str]


class IntakeDelta(_Out):
    id: str
    conversations_before: int
    conversations_after: int
    friction_share_before: float | None
    friction_share_after: float | None


class IntakeSummary(_Out):
    batch_size: int
    decided: int
    other: int
    published_snapshot_id: str
    base_snapshot_id: str
    deltas: list[IntakeDelta]


class Error(_Out):
    code: str
    message: str


class Run(_Out):
    run_id: str
    kind: Literal["analysis", "story", "prd", "brief", "containment", "intake"]
    intent: Literal["question"] | None
    snapshot_id: str
    state: Literal["queued", "planning", "executing", "validating", "repairing", "explaining", "completed", "failed"]
    created_at: str
    updated_at: str
    stages: list[Stage]
    attempts: int
    code: str | None
    receipt: Receipt | None
    verdict: Verdict | None
    result: QuestionResult | None
    explanation: Explanation | None
    containment: Containment | None
    error: Error | None
    question: str | None
    plan: Plan | None
    attempts_log: list[Attempt]
    intake: IntakeSummary | None


class Story(_Out):
    cluster_id: str
    snapshot_id: str
    label: str
    first_name: str
    text: str
    citations: list[str]
    model: str
    generated_at: str


class PrdPriority(_Out):
    level: Literal["P0", "P1", "P2"] | None
    rank: int | None
    of: int
    basis: str


class PrdMetric(_Out):
    name: str
    value: str


class Prd(_Out):
    cluster_id: str
    snapshot_id: str
    label: str
    title: str
    problem: str
    user_stories: list[str]
    requirements: list[str]
    success_metrics: list[str]
    citations: list[str]
    metrics_used: list[PrdMetric]
    priority: PrdPriority
    model: str
    generated_at: str


class BriefMetric(_Out):
    name: str
    value: str


class BriefDataset(_Out):
    name: str
    workspace: str
    period_start: str
    period_end: str


class BriefTotals(_Out):
    conversations: int
    people: int
    languages: int
    friction_share: float | None
    friction_conversations: int
    unclear: int


class BriefLeaf(_Out):
    id: str
    title: str
    share: float | None
    conversations: int
    friction_share: float | None


class BriefCategory(BriefLeaf):
    is_other: bool
    children: list[BriefLeaf]


class MapData(_Out):
    categories: list[BriefCategory]


class TopItem(_Out):
    id: str
    title: str
    category: str
    share: float | None
    conversations: int
    people: int


class TopData(_Out):
    items: list[TopItem]


class FrictionItem(_Out):
    id: str
    title: str
    friction_share: float | None
    friction_conversations: int
    conversations: int


class FrictionData(_Out):
    overall_share: float | None
    items: list[FrictionItem]


class SignalItem(_Out):
    signal: Signal
    label: str
    conversations: int


class SignalsData(_Out):
    friction_conversations: int
    items: list[SignalItem]


class SpotlightData(_Out):
    id: str
    title: str
    category: str
    description: str
    share: float | None
    conversations: int
    people: int
    friction_share: float | None
    signals: Signals
    problems: list[str]
    needs: list[str]


class LanguageItem(_Out):
    name: str
    conversations: int
    share: float


class LanguagesData(_Out):
    languages: int
    items: list[LanguageItem]


class OutroData(_Out):
    snapshot_id: str
    pipeline: str


class ChangeItem(_Out):
    id: str
    title: str
    before: int
    after: int
    friction_share_before: float | None
    friction_share_after: float | None


class ChangeData(_Out):
    base_snapshot_id: str
    conversations_before: int
    conversations_after: int
    added_conversations: int
    friction_share_before: float | None
    friction_share_after: float | None
    items: list[ChangeItem]


class BriefScene(_Out):
    type: Literal["intro", "change", "map", "top_workflows", "friction", "signals", "spotlight", "languages", "takeaways", "outro"]
    seconds: int
    from_frame: int
    frames: int
    headline: str
    kicker: str | None = None
    cluster_id: str | None = None
    insight: str | None = None
    bullets: list[str] | None = None
    data: (MapData | TopData | FrictionData | SignalsData | SpotlightData | LanguagesData | OutroData | ChangeData | None) = None


class Brief(_Out):
    brief_id: str
    snapshot_id: str
    generated_at: str
    model: str
    label: str
    fps: int
    width: int
    height: int
    duration_frames: int
    title: str
    dataset: BriefDataset
    totals: BriefTotals
    scenes: list[BriefScene]
    metrics_used: list[BriefMetric]
    checks: list[str]
    attempts: int
    video_status: Literal["ready", "rendering", "failed", "none", "unavailable"]
    video_url: str | None


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
    intent: Literal["question"]          # usage/friction were retired (docs/CONTRACTS.md §0) → 422
    snapshot_id: str = Field(max_length=40)
    question: str = Field(min_length=1, max_length=200)


class StoryIn(_In):
    snapshot_id: str = Field(max_length=40)


class BriefIn(_In):
    snapshot_id: str | None = Field(default=None, max_length=40)
    regenerate: bool = False


class ContainmentIn(_In):
    pass
