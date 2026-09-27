/** Provisional public contracts. This module contains no private-record types. */
export type AnalysisIntent = "usage" | "friction";

export interface ClusterMetrics {
  conversationCount: number;
  /** Share of all conversations in this snapshot, expressed as a ratio. */
  conversationShare: number | null;
  observedFrictionCount: number;
  /** Share of this cluster's conversations, expressed as a ratio. */
  observedFrictionShare: number | null;
  /** No observed signal and at least one unclear assessment; never a success count. */
  unclearCount: number;
  /** Signals can overlap within a conversation. Do not sum them as overall friction. */
  signals: {
    corrections: number;
    complaints: number;
    unresolvedErrors: number;
  };
}

export interface PublishedEvidence {
  id: string;
  label: string;
  description: string;
}

export interface Cluster {
  id: string;
  snapshotId: string;
  parentId: string;
  title: string;
  shortTitle: string;
  summary: string;
  needs: string[];
  gripes: string[];
  metrics: ClusterMetrics;
  evidence: PublishedEvidence[];
}

export interface Category {
  id: string;
  title: string;
}

export interface Snapshot {
  id: string;
  synthetic: true;
  period: { start: string; end: string; label: string };
  totals: {
    conversationCount: number;
    observedFrictionCount: number;
    unclearCount: number;
  };
  categories: Category[];
  clusters: Cluster[];
  provenance: { label: string; generatedAt: string };
}

export interface SearchResult {
  snapshotId: string;
  query: string;
  clusterIds: string[];
  categoryIds: string[];
  elapsedMs: number;
}

export interface AnalysisResult {
  kind: "analysis";
  snapshotId: string;
  intent: AnalysisIntent;
  orderedClusterIds: string[];
  metrics: Array<{ clusterId: string; metrics: ClusterMetrics }>;
  summary: string;
  evidenceIds: string[];
  generatedAt: string;
  simulated: true;
}

export interface FictionalStory {
  id: string;
  snapshotId: string;
  clusterId: string;
  label: "Fictional user story";
  disclosure: string;
  name: string;
  body: string;
  evidenceIds: string[];
  generatedAt: string;
  simulated: true;
}

export interface SimulatedExecutionReceipt {
  simulated: true;
  label: "Simulated execution · no sandbox was run";
  outcome: "simulated-completed" | "simulated-failed";
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  programHash: null;
  sandboxId: null;
  provider: "Local mock";
}

export type RunStage =
  | "planning"
  | "executing"
  | "validating"
  | "explaining"
  | "completed"
  | "failed";

interface RunBase {
  id: string;
  snapshotId: string;
  kind: "analysis" | "story";
  intent?: AnalysisIntent;
  clusterId?: string;
  startedAt: string;
  updatedAt: string;
  attemptCount: 1;
  simulated: true;
}

export type DemoRun = RunBase &
  (
    | {
        state: "running";
        stage: Exclude<RunStage, "completed" | "failed">;
        validationStatus: "pending";
        result?: never;
        error?: never;
        executionReceipt?: never;
        completedAt?: never;
      }
    | {
        state: "completed";
        stage: "completed";
        validationStatus: "passed";
        completedAt: string;
        result: AnalysisResult | { kind: "story"; story: FictionalStory };
        executionReceipt?: SimulatedExecutionReceipt;
        error?: never;
      }
    | {
        state: "failed";
        stage: "failed";
        validationStatus: "failed";
        completedAt: string;
        result?: never;
        executionReceipt?: SimulatedExecutionReceipt;
        error: { code: string; message: string; retryable: true };
      }
  );

export type StoryRequestResult =
  | { status: "cached"; story: FictionalStory }
  | { status: "pending"; runId: string };

export interface DemoAdapter {
  getSnapshot(options?: { signal?: AbortSignal }): Promise<Snapshot>;
  search(request: {
    snapshotId: string;
    query: string;
    signal?: AbortSignal;
  }): Promise<SearchResult>;
  createAnalysis(request: {
    snapshotId: string;
    intent: AnalysisIntent;
  }): Promise<{ runId: string }>;
  getRun(runId: string, options?: { signal?: AbortSignal }): Promise<DemoRun>;
  requestStory(request: {
    snapshotId: string;
    clusterId: string;
  }): Promise<StoryRequestResult>;
}

export interface DemoAdapterOptions {
  /** Network-like read delay. Run duration is a deterministic multiple of this value. */
  delayMs?: number;
  /** One recoverable failure per adapter, solely for development state inspection. */
  failure?: "snapshot" | "search" | "analysis" | "story";
  empty?: boolean;
}
