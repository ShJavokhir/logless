import type { Metrics, Run, SearchResponse, Snapshot as ApiSnapshot, Story, StoryResponse } from "../../../web/src/lib/types";
import { fillTemplate, segmentsToString } from "../../../web/src/lib/template";
import type { AnalysisIntent, ClusterMetrics, DemoAdapter, DemoRun, FictionalStory, Snapshot } from "./types";

export class LiveApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type LiveMetrics = Omit<Metrics, "friction"> & { friction: Omit<Metrics["friction"], "signals"> & {
  signals: Partial<Metrics["friction"]["signals"]> & { correction: number; complaint: number; unresolved_action_error?: number }
} };
type LiveSnapshot = Omit<ApiSnapshot, "dataset" | "provenance" | "totals" | "categories" | "clusters"> & {
  dataset: Omit<ApiSnapshot["dataset"], "name" | "license"> & { name: string; license: string; synthetic?: boolean };
  provenance: ApiSnapshot["provenance"] & { taxonomy_version?: string };
  totals: LiveMetrics;
  categories: Array<Omit<ApiSnapshot["categories"][number], keyof Metrics> & LiveMetrics>;
  clusters: Array<Omit<ApiSnapshot["clusters"][number], keyof Metrics> & LiveMetrics>;
};

function metrics(value: LiveMetrics): ClusterMetrics {
  return {
    conversationCount: value.conversations,
    conversationShare: value.share,
    observedFrictionCount: value.friction.conversations,
    observedFrictionShare: value.friction.share,
    unclearCount: value.friction.unclear,
    signals: {
      corrections: value.friction.signals.correction,
      complaints: value.friction.signals.complaint,
      repeatRequests: value.friction.signals.repeat_request,
      assistantLimits: value.friction.signals.assistant_limit,
      unresolvedErrors: value.friction.signals.unresolved_action_error,
    },
  };
}

export function mapSnapshot(value: LiveSnapshot): Snapshot {
  return {
    id: value.snapshot_id,
    synthetic: value.dataset.synthetic === true,
    workspaceName: value.workspace.name,
    datasetNote: value.dataset.sample_note,
    attribution: `${value.dataset.attribution} · ${value.dataset.license}`,
    sourceUrl: value.dataset.source_url,
    taxonomyVersion: value.provenance.taxonomy_version,
    period: { start: value.dataset.period_start, end: value.dataset.period_end, label: `${value.dataset.period_start} – ${value.dataset.period_end}` },
    totals: { conversationCount: value.totals.conversations, observedFrictionCount: value.totals.friction.conversations, unclearCount: value.totals.friction.unclear },
    categories: value.categories.map(({ id, title }) => ({ id, title })),
    clusters: value.clusters.map((node) => ({
      id: node.id, snapshotId: value.snapshot_id, parentId: node.parent_id ?? "", title: node.title,
      shortTitle: node.short_title || node.title, summary: node.description,
      needs: (node.needs ?? []).map((item) => item.text),
      gripes: (node.problems ?? []).map((item) => item.text),
      metrics: metrics(node),
      evidence: [
        ...(node.needs ?? []).map((item) => ({ id: item.id, label: `Need · ${item.id}`, description: item.text })),
        ...(node.problems ?? []).map((item) => ({ id: item.id, label: `${item.support === "common" ? "Common" : "Observed"} problem · ${item.id}`, description: item.text })),
      ],
    })),
    provenance: { label: `${value.dataset.name} · published aggregates`, generatedAt: value.created_at },
  };
}

function mapStory(story: Story): FictionalStory {
  return {
    id: `${story.snapshot_id}:${story.cluster_id}`, snapshotId: story.snapshot_id, clusterId: story.cluster_id,
    label: "Fictional user story", disclosure: "An invented person illustrating published aggregate evidence. This is not a real conversation or customer testimonial.",
    name: story.first_name, body: story.text, evidenceIds: story.citations, generatedAt: story.generated_at, simulated: false,
  };
}

// Keep the branch's presentation model at this boundary; API contracts stay shared with master.
export function createLiveAdapter(fetcher: typeof fetch = fetch): DemoAdapter {
  let snapshot: Snapshot | undefined;
  const requests = new Map<string, { snapshotId: string; intent?: AnalysisIntent; clusterId?: string }>();
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(`/api${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new LiveApiError(error?.code ?? "request_failed", error?.message ?? `The API request failed (${response.status}).`);
    }
    return response.json();
  }
  async function storyRequest(snapshotId: string, clusterId: string, signal?: AbortSignal) {
    const value = await request<StoryResponse>(`/clusters/${encodeURIComponent(clusterId)}/story`, { snapshot_id: snapshotId }, signal);
    if (value.status === "ready") {
      if (value.story.snapshot_id !== snapshotId || value.story.cluster_id !== clusterId) throw new Error("Story does not match this workflow.");
      return { status: "cached" as const, story: mapStory(value.story) };
    }
    requests.set(value.run_id, { snapshotId, clusterId });
    return { status: "pending" as const, runId: value.run_id };
  }
  return {
    async getSnapshot(options) {
      snapshot = mapSnapshot(await request<LiveSnapshot>("/snapshot", undefined, options?.signal));
      return snapshot;
    },
    async search({ snapshotId, query, signal }) {
      const value = await request<SearchResponse>("/search", { snapshot_id: snapshotId, query }, signal);
      return { snapshotId: value.snapshot_id, query: value.query, clusterIds: value.results.filter((item) => item.relevance === "relevant").map((item) => item.cluster_id), categoryIds: [], elapsedMs: value.elapsed_ms };
    },
    async createAnalysis({ snapshotId, intent }) {
      const question = intent === "usage"
        ? "Which ten workflows have the most conversations? Group by leaf workflow and rank by conversation count."
        : "Which ten workflows have the most conversations with any observed friction? Group by leaf workflow and rank by count.";
      const value = await request<{ run_id: string }>("/analyses", { snapshot_id: snapshotId, intent: "question", question });
      requests.set(value.run_id, { snapshotId, intent });
      return { runId: value.run_id };
    },
    async getRun(runId, options): Promise<DemoRun> {
      const context = requests.get(runId);
      if (!context) throw new Error("Unknown run. Start the analysis again.");
      const value = await request<Run>(`/runs/${encodeURIComponent(runId)}`, undefined, options?.signal);
      if (value.snapshot_id !== context.snapshotId) throw new Error("Run does not match this snapshot.");
      const base = { id: runId, snapshotId: value.snapshot_id, kind: context.clusterId ? "story" as const : "analysis" as const, intent: context.intent, clusterId: context.clusterId, startedAt: value.created_at, updatedAt: value.updated_at, attemptCount: value.attempts, simulated: false };
      const receipt = value.receipt ? { simulated: false as const, label: `${value.receipt.runtime} · ${value.receipt.elapsed_ms} ms · ${value.receipt.container_removed ? "container removed" : "container removal not confirmed"}` } : undefined;
      if (value.state === "failed") return { ...base, state: "failed", stage: "failed", validationStatus: "failed", completedAt: value.updated_at, executionReceipt: receipt, error: { code: value.error?.code ?? "failed", message: value.error?.message ?? "The run failed.", retryable: true } };
      if (value.state !== "completed") {
        const stage = ["planning", "executing", "validating", "explaining"].includes(value.state) ? value.state as "planning" | "executing" | "validating" | "explaining" : "planning";
        return { ...base, state: "running", stage, validationStatus: "pending" };
      }
      const completed = { ...base, state: "completed" as const, stage: "completed" as const, validationStatus: "passed" as const, completedAt: value.updated_at, executionReceipt: receipt };
      if (context.clusterId) {
        // Story runs publish into the story cache, not Run.result.
        const response = await storyRequest(context.snapshotId, context.clusterId, options?.signal);
        if (response.status !== "cached") throw new Error("The completed story is not available yet.");
        return { ...completed, result: { kind: "story", story: response.story } };
      }
      if (!snapshot || snapshot.id !== value.snapshot_id || !context.intent || !value.result || value.result.intent !== "question" || !value.verdict?.passed) throw new Error("The analysis has no validated result for this snapshot.");
      const result = value.result;
      const plan = result.plan;
      if (plan.group_by !== "leaf" || plan.scope_category_id !== null || plan.measure !== "conversations" || plan.rank_by !== "count" || plan.signal !== (context.intent === "friction" ? "any_friction" : null)) throw new Error("The analysis answered a different question. The published finding remains available.");
      const ids = new Set(snapshot.clusters.map((cluster) => cluster.id));
      if (result.rows.some((row) => !ids.has(row.id))) throw new Error("The analysis refers to an unknown workflow.");
      return { ...completed, result: {
        kind: "analysis", snapshotId: value.snapshot_id, intent: context.intent,
        orderedClusterIds: result.rows.map((row) => row.id), metrics: [],
        summary: value.explanation ? segmentsToString(fillTemplate(value.explanation.text, result, (id) => snapshot?.clusters.find((cluster) => cluster.id === id)?.title)) : "Analysis completed and validated against the published snapshot.",
        evidenceIds: [], generatedAt: value.updated_at, simulated: false,
      } };
    },
    requestStory: ({ snapshotId, clusterId }) => storyRequest(snapshotId, clusterId),
  };
}
