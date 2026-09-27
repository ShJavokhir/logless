import { searchTerms, snapshotFixture, storyFixtures } from "./fixtures";
import type {
  AnalysisIntent,
  AnalysisResult,
  DemoAdapter,
  DemoAdapterOptions,
  DemoRun,
  FictionalStory,
  RunStage,
  SimulatedExecutionReceipt,
  Snapshot,
} from "./types";

export class DemoDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DemoDataError";
  }
}

interface StoredRun {
  id: string;
  kind: "analysis" | "story";
  intent?: AnalysisIntent;
  clusterId?: string;
  startedMs: number;
  durationMs: number;
  shouldFail: boolean;
}

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "doing",
  "find",
  "for",
  "from",
  "get",
  "help",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "people",
  "s",
  "the",
  "their",
  "them",
  "to",
  "with",
  "what",
  "when",
  "workflow",
]);

function normalized(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function abortError(): DOMException {
  return new DOMException(
    "The request was superseded or cancelled.",
    "AbortError",
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Frontend-only transport replacement, never a fallback for failed live requests.
 * Fixture imports remain here so components depend only on the public adapter.
 */
export function createDemoAdapter(
  options: DemoAdapterOptions = {},
): DemoAdapter {
  if (
    options.delayMs !== undefined &&
    (!Number.isFinite(options.delayMs) || options.delayMs < 0)
  ) {
    throw new DemoDataError(
      "invalid-delay",
      "Demo delay must be a finite, nonnegative number.",
    );
  }
  const scale = options.delayMs === undefined ? 1 : options.delayMs / 400;
  const delay = (milliseconds: number) => Math.round(milliseconds * scale);
  const snapshot: Snapshot = structuredClone(snapshotFixture);
  if (options.empty) {
    snapshot.categories = [];
    snapshot.clusters = [];
    snapshot.totals = {
      conversationCount: 0,
      observedFrictionCount: 0,
      unclearCount: 0,
    };
  }
  const runs = new Map<string, StoredRun>();
  const storyCache = new Map<string, FictionalStory>();
  let sequence = 0;
  let failureRemaining = options.failure;

  function takeFailure(kind: DemoAdapterOptions["failure"]): boolean {
    if (failureRemaining !== kind) return false;
    failureRemaining = undefined;
    return true;
  }

  function validateSnapshot(snapshotId: string): void {
    if (snapshotId !== snapshot.id) {
      throw new DemoDataError(
        "snapshot-mismatch",
        "This request belongs to a different snapshot. Reload the current insights.",
      );
    }
  }

  function validateCluster(clusterId: string): void {
    if (!snapshot.clusters.some((cluster) => cluster.id === clusterId)) {
      throw new DemoDataError(
        "cluster-not-found",
        "This workflow is not present in the current snapshot.",
      );
    }
  }

  function analysisResult(run: StoredRun, generatedAt: string): AnalysisResult {
    const intent = run.intent!;
    const ordered = [...snapshot.clusters].sort((left, right) => {
      const difference =
        intent === "usage"
          ? right.metrics.conversationCount - left.metrics.conversationCount
          : right.metrics.observedFrictionCount -
            left.metrics.observedFrictionCount;
      return difference || left.id.localeCompare(right.id);
    });
    const first = ordered[0];
    const summary = !first
      ? "There are no published conversations to analyze in this demo snapshot."
      : intent === "usage"
        ? `${first.title} is the largest workflow: ${first.metrics.conversationCount} of ${snapshot.totals.conversationCount} conversations (${((first.metrics.conversationShare ?? 0) * 100).toFixed(1)}%).`
        : `${first.title} has the most observed friction: ${first.metrics.observedFrictionCount} of its ${first.metrics.conversationCount} conversations (${((first.metrics.observedFrictionShare ?? 0) * 100).toFixed(1)}%).`;
    return {
      kind: "analysis",
      snapshotId: snapshot.id,
      intent,
      orderedClusterIds: ordered.map((cluster) => cluster.id),
      metrics: ordered.map((cluster) => ({
        clusterId: cluster.id,
        metrics: structuredClone(cluster.metrics),
      })),
      summary,
      evidenceIds: ordered.map((cluster) => `${cluster.id}:metrics`),
      generatedAt,
      simulated: true,
    };
  }

  function resolveRun(run: StoredRun): DemoRun {
    const elapsed = Math.max(0, Date.now() - run.startedMs);
    const startedAt = new Date(run.startedMs).toISOString();
    const terminal = elapsed >= run.durationMs;
    const completedAt = new Date(run.startedMs + run.durationMs).toISOString();
    const base = {
      id: run.id,
      snapshotId: snapshot.id,
      kind: run.kind,
      ...(run.intent ? { intent: run.intent } : {}),
      ...(run.clusterId ? { clusterId: run.clusterId } : {}),
      startedAt,
      updatedAt: terminal
        ? completedAt
        : new Date(run.startedMs + elapsed).toISOString(),
      attemptCount: 1 as const,
      simulated: true as const,
    };
    if (!terminal) {
      const progress = elapsed / run.durationMs;
      // Story authoring never has an execution stage or a sandbox receipt.
      const stage: Exclude<RunStage, "completed" | "failed"> =
        run.kind === "story"
          ? progress < 0.25
            ? "planning"
            : progress < 0.72
              ? "validating"
              : "explaining"
          : progress < 0.2
            ? "planning"
            : progress < 0.53
              ? "executing"
              : progress < 0.78
                ? "validating"
                : "explaining";
      return { ...base, state: "running", stage, validationStatus: "pending" };
    }
    const executionReceipt: SimulatedExecutionReceipt | undefined =
      run.kind === "analysis"
        ? {
            simulated: true,
            label: "Simulated execution · no sandbox was run",
            outcome: run.shouldFail
              ? "simulated-failed"
              : "simulated-completed",
            startedAt,
            completedAt,
            elapsedMs: run.durationMs,
            programHash: null,
            sandboxId: null,
            provider: "Local mock",
          }
        : undefined;
    if (run.shouldFail) {
      return {
        ...base,
        state: "failed",
        stage: "failed",
        validationStatus: "failed",
        completedAt,
        ...(executionReceipt ? { executionReceipt } : {}),
        error: {
          code: `demo-${run.kind}-failure`,
          message:
            run.kind === "analysis"
              ? "The simulated analysis could not finish. Your published insights are still available."
              : "The fictional example could not be prepared. Try again to use the same published evidence.",
          retryable: true,
        },
      };
    }
    if (run.kind === "analysis") {
      return {
        ...base,
        state: "completed",
        stage: "completed",
        validationStatus: "passed",
        completedAt,
        executionReceipt,
        result: analysisResult(run, completedAt),
      };
    }
    const clusterId = run.clusterId!;
    let story = storyCache.get(clusterId);
    if (!story) {
      story = {
        ...structuredClone(storyFixtures[clusterId]),
        generatedAt: completedAt,
      };
      storyCache.set(clusterId, story);
    }
    return {
      ...base,
      state: "completed",
      stage: "completed",
      validationStatus: "passed",
      completedAt,
      result: { kind: "story", story: structuredClone(story) },
    };
  }

  function activeRun(
    kind: "analysis" | "story",
    value: string,
  ): StoredRun | undefined {
    for (const run of runs.values()) {
      if (
        run.kind === kind &&
        (kind === "analysis" ? run.intent : run.clusterId) === value
      ) {
        if (resolveRun(run).state === "running") return run;
      }
    }
    return undefined;
  }

  return {
    async getSnapshot({ signal } = {}) {
      await wait(delay(400), signal);
      if (takeFailure("snapshot")) {
        throw new DemoDataError(
          "demo-snapshot-failure",
          "The demo snapshot could not load. Try again.",
          true,
        );
      }
      return structuredClone(snapshot);
    },

    async search({ snapshotId, query, signal }) {
      validateSnapshot(snapshotId);
      if (typeof query !== "string" || query.length > 300) {
        throw new DemoDataError(
          "invalid-query",
          "Enter a workflow description of 300 characters or fewer.",
        );
      }
      const started = performance.now();
      await wait(delay(220), signal);
      if (takeFailure("search")) {
        throw new DemoDataError(
          "demo-search-failure",
          "Search could not finish. You can still explore every published workflow.",
          true,
        );
      }
      const cleanQuery = normalized(query);
      const tokens = cleanQuery
        .split(" ")
        .filter((token) => token && !stopWords.has(token));
      const matching = snapshot.clusters.filter((cluster) => {
        if (!cleanQuery) return true;
        const terms = searchTerms[cluster.id];
        return terms.some((term) => {
          const words = normalized(term).split(" ");
          return words.length > 1
            ? cleanQuery.includes(term)
            : tokens.includes(term);
        });
      });
      return {
        snapshotId: snapshot.id,
        query,
        clusterIds: matching.map((cluster) => cluster.id),
        categoryIds: [...new Set(matching.map((cluster) => cluster.parentId))],
        elapsedMs: Math.round(performance.now() - started),
      };
    },

    async createAnalysis({ snapshotId, intent }) {
      validateSnapshot(snapshotId);
      if (intent !== "usage" && intent !== "friction") {
        throw new DemoDataError(
          "invalid-intent",
          "Choose usage or friction analysis.",
        );
      }
      await wait(delay(60));
      const existing = activeRun("analysis", intent);
      if (existing) return { runId: existing.id };
      const id = `demo-analysis-${++sequence}`;
      runs.set(id, {
        id,
        kind: "analysis",
        intent,
        startedMs: Date.now(),
        durationMs: delay(1700),
        shouldFail: takeFailure("analysis"),
      });
      return { runId: id };
    },

    async getRun(runId, { signal } = {}) {
      await wait(delay(35), signal);
      const run = runs.get(runId);
      if (!run)
        throw new DemoDataError(
          "run-not-found",
          "This demo run is not available. Start a new request.",
        );
      return resolveRun(run);
    },

    async requestStory({ snapshotId, clusterId }) {
      validateSnapshot(snapshotId);
      validateCluster(clusterId);
      await wait(delay(60));
      const existing = activeRun("story", clusterId);
      const cached = storyCache.get(clusterId);
      if (cached) return { status: "cached", story: structuredClone(cached) };
      if (existing) return { status: "pending", runId: existing.id };
      const id = `demo-story-${++sequence}`;
      runs.set(id, {
        id,
        kind: "story",
        clusterId,
        startedMs: Date.now(),
        durationMs: delay(1300),
        shouldFail: takeFailure("story"),
      });
      return { status: "pending", runId: id };
    },
  };
}
