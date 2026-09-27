import assert from "node:assert/strict";
import test from "node:test";
import { createDemoAdapter, DemoDataError } from "./index";
import type { DemoAdapter, DemoRun, Snapshot } from "./index";

async function finish(adapter: DemoAdapter, runId: string): Promise<DemoRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await adapter.getRun(runId);
    if (run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  throw new Error("The local mock run did not reach a terminal state.");
}

function sum(
  snapshot: Snapshot,
  metric: "conversationCount" | "observedFrictionCount" | "unclearCount",
): number {
  return snapshot.clusters.reduce(
    (total, cluster) => total + cluster.metrics[metric],
    0,
  );
}

test("published counts reconcile; ratios use the correct denominators and overlapping signals", async () => {
  const snapshot = await createDemoAdapter({ delayMs: 0 }).getSnapshot();
  assert.equal(snapshot.synthetic, true);
  assert.equal(snapshot.clusters.length, 12);
  assert.equal(snapshot.categories.length, 4);
  assert.equal(snapshot.totals.conversationCount, 600);
  assert.equal(
    new Set(snapshot.clusters.map((cluster) => cluster.id)).size,
    12,
  );
  for (const metric of [
    "conversationCount",
    "observedFrictionCount",
    "unclearCount",
  ] as const) {
    assert.equal(sum(snapshot, metric), snapshot.totals[metric]);
  }
  assert.deepEqual(
    snapshot.categories.map((category) =>
      snapshot.clusters
        .filter((cluster) => cluster.parentId === category.id)
        .reduce(
          (total, cluster) => total + cluster.metrics.conversationCount,
          0,
        ),
    ),
    [234, 162, 126, 78],
  );
  for (const cluster of snapshot.clusters) {
    const metrics = cluster.metrics;
    assert.equal(cluster.snapshotId, snapshot.id);
    assert(
      snapshot.categories.some((category) => category.id === cluster.parentId),
    );
    assert.equal(metrics.conversationShare, metrics.conversationCount / 600);
    assert.equal(
      metrics.observedFrictionShare,
      metrics.observedFrictionCount / metrics.conversationCount,
    );
    assert(
      metrics.observedFrictionCount + metrics.unclearCount <=
        metrics.conversationCount,
    );
    const signals = Object.values(metrics.signals);
    assert(
      signals.every(
        (count) =>
          Number.isInteger(count) &&
          count >= 0 &&
          count <= metrics.observedFrictionCount,
      ),
    );
    assert(
      signals.reduce((total, count) => total + count, 0) >=
        metrics.observedFrictionCount,
    );
  }
  const hero = snapshot.clusters.find(
    (cluster) => cluster.id === "changing-plans",
  )!;
  assert.equal(hero.metrics.conversationCount, 108);
  assert.equal(hero.metrics.observedFrictionCount, 46);
  assert(
    Object.values(hero.metrics.signals).reduce(
      (total, count) => total + count,
      0,
    ) > 46,
  );
});

test("search returns stable aggregate IDs, supports no matches and clearing, and never changes metrics", async () => {
  const adapter = createDemoAdapter({ delayMs: 0 });
  const snapshot = await adapter.getSnapshot();
  const first = await adapter.search({
    snapshotId: snapshot.id,
    query: "coordinating with other people",
  });
  const second = await adapter.search({
    snapshotId: snapshot.id,
    query: "coordinating with other people",
  });
  assert.deepEqual(first.clusterIds, [
    "changing-plans",
    "shared-commitments",
    "closing-the-loop",
  ]);
  assert.deepEqual(first.categoryIds, ["coordination"]);
  assert.deepEqual(first.clusterIds, second.clusterIds);
  assert(first.elapsedMs >= 0);
  assert.deepEqual(
    (
      await adapter.search({
        snapshotId: snapshot.id,
        query: "quantum banana orchestra",
      })
    ).clusterIds,
    [],
  );
  assert.deepEqual(
    (
      await adapter.search({
        snapshotId: snapshot.id,
        query: "private customer transcripts",
      })
    ).clusterIds,
    [],
  );
  assert.equal(
    (await adapter.search({ snapshotId: snapshot.id, query: "" })).clusterIds
      .length,
    12,
  );
  assert.deepEqual(await adapter.getSnapshot(), snapshot);
});

test("aborted snapshot, search, and run reads reject without yielding stale results", async () => {
  const adapter = createDemoAdapter({ delayMs: 10 });
  const controller = new AbortController();
  const request = adapter.getSnapshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  const snapshot = await adapter.getSnapshot();
  await assert.rejects(
    adapter.search({
      snapshotId: snapshot.id,
      query: "travel",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  const { runId } = await adapter.createAnalysis({
    snapshotId: snapshot.id,
    intent: "usage",
  });
  await assert.rejects(adapter.getRun(runId, { signal: controller.signal }), {
    name: "AbortError",
  });
});

test("cross-snapshot references, unknown clusters, and unsupported analysis intents are rejected", async () => {
  const adapter = createDemoAdapter({ delayMs: 0 });
  const snapshot = await adapter.getSnapshot();
  for (const request of [
    () => adapter.search({ snapshotId: "another-snapshot", query: "travel" }),
    () =>
      adapter.createAnalysis({
        snapshotId: "another-snapshot",
        intent: "usage",
      }),
    () =>
      adapter.requestStory({
        snapshotId: "another-snapshot",
        clusterId: "changing-plans",
      }),
  ]) {
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof DemoDataError && error.code === "snapshot-mismatch",
    );
  }
  await assert.rejects(
    adapter.requestStory({ snapshotId: snapshot.id, clusterId: "unknown" }),
    { code: "cluster-not-found" },
  );
  await assert.rejects(
    adapter.createAnalysis({
      snapshotId: snapshot.id,
      intent: "arbitrary" as "usage",
    }),
    { code: "invalid-intent" },
  );
  await assert.rejects(adapter.getRun("unknown"), { code: "run-not-found" });
});

test("analysis deduplicates in-flight requests and returns validated ordering with an explicit mock receipt", async () => {
  const adapter = createDemoAdapter({ delayMs: 20 });
  const snapshot = await adapter.getSnapshot();
  const first = await adapter.createAnalysis({
    snapshotId: snapshot.id,
    intent: "friction",
  });
  const duplicate = await adapter.createAnalysis({
    snapshotId: snapshot.id,
    intent: "friction",
  });
  assert.equal(first.runId, duplicate.runId);
  const pending = await adapter.getRun(first.runId);
  assert.equal(pending.state, "running");
  assert.equal(pending.validationStatus, "pending");
  assert.equal(pending.result, undefined);
  const completed = await finish(adapter, first.runId);
  assert.equal(completed.state, "completed");
  if (completed.state !== "completed" || completed.result.kind !== "analysis")
    throw new Error("Missing analysis result");
  assert.equal(completed.validationStatus, "passed");
  assert.equal(completed.executionReceipt?.simulated, true);
  assert.equal(completed.executionReceipt?.sandboxId, null);
  assert.equal(completed.executionReceipt?.programHash, null);
  assert.match(completed.executionReceipt?.label ?? "", /no sandbox was run/);
  assert.equal(completed.result.snapshotId, snapshot.id);
  assert.equal(completed.result.orderedClusterIds[0], "changing-plans");
  const counts = completed.result.metrics.map(
    (row) => row.metrics.observedFrictionCount,
  );
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
  );
  for (const row of completed.result.metrics) {
    assert.deepEqual(
      row.metrics,
      snapshot.clusters.find((cluster) => cluster.id === row.clusterId)
        ?.metrics,
    );
  }
  const next = await adapter.createAnalysis({
    snapshotId: snapshot.id,
    intent: "friction",
  });
  assert.notEqual(next.runId, first.runId);
});

test("all authored stories have 90–140 words and reference only their selected cluster's published evidence", async () => {
  const adapter = createDemoAdapter({ delayMs: 0 });
  const snapshot = await adapter.getSnapshot();
  for (const cluster of snapshot.clusters) {
    const request = await adapter.requestStory({
      snapshotId: snapshot.id,
      clusterId: cluster.id,
    });
    assert.equal(request.status, "pending");
    if (request.status !== "pending") throw new Error("Expected a story run");
    const completed = await finish(adapter, request.runId);
    if (completed.state !== "completed" || completed.result.kind !== "story")
      throw new Error("Missing story result");
    assert.equal(completed.executionReceipt, undefined);
    const story = completed.result.story;
    const words = story.body.split(/\s+/).length;
    assert(words >= 90 && words <= 140, `${cluster.id} has ${words} words`);
    assert.equal(story.label, "Fictional user story");
    assert.equal(story.snapshotId, snapshot.id);
    assert.equal(story.clusterId, cluster.id);
    assert.equal(story.simulated, true);
    assert(
      story.evidenceIds.every((id) =>
        cluster.evidence.some((claim) => claim.id === id),
      ),
    );
    assert.match(
      story.disclosure,
      /not a real customer or additional evidence/,
    );
    const cached = await adapter.requestStory({
      snapshotId: snapshot.id,
      clusterId: cluster.id,
    });
    assert.equal(cached.status, "cached");
    if (cached.status === "cached") assert.deepEqual(cached.story, story);
    if (cluster.gripes.length === 0)
      assert.match(story.body, /No specific frustration is established/);
  }
});

test("story jobs deduplicate and can be cached without an explicit terminal poll", async () => {
  const adapter = createDemoAdapter({ delayMs: 10 });
  const snapshot = await adapter.getSnapshot();
  const first = await adapter.requestStory({
    snapshotId: snapshot.id,
    clusterId: "changing-plans",
  });
  const second = await adapter.requestStory({
    snapshotId: snapshot.id,
    clusterId: "changing-plans",
  });
  assert.deepEqual(first, second);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    (
      await adapter.requestStory({
        snapshotId: snapshot.id,
        clusterId: "changing-plans",
      })
    ).status,
    "cached",
  );
});

test("configured read failures occur once and remain recoverable", async () => {
  for (const failure of ["snapshot", "search"] as const) {
    const adapter = createDemoAdapter({ delayMs: 0, failure });
    if (failure === "snapshot") {
      await assert.rejects(adapter.getSnapshot(), { retryable: true });
      assert.equal((await adapter.getSnapshot()).totals.conversationCount, 600);
    } else {
      const snapshot = await adapter.getSnapshot();
      await assert.rejects(
        adapter.search({ snapshotId: snapshot.id, query: "travel" }),
        { retryable: true },
      );
      assert.equal(
        (await adapter.search({ snapshotId: snapshot.id, query: "travel" }))
          .clusterIds.length,
        3,
      );
    }
  }
});

test("failed analysis and story runs preserve insights and retry successfully", async () => {
  for (const failure of ["analysis", "story"] as const) {
    const adapter = createDemoAdapter({ delayMs: 0, failure });
    const snapshot = await adapter.getSnapshot();
    const request = async () => {
      if (failure === "analysis")
        return (
          await adapter.createAnalysis({
            snapshotId: snapshot.id,
            intent: "usage",
          })
        ).runId;
      const result = await adapter.requestStory({
        snapshotId: snapshot.id,
        clusterId: "changing-plans",
      });
      if (result.status !== "pending")
        throw new Error("Expected a pending story");
      return result.runId;
    };
    const failed = await finish(adapter, await request());
    assert.equal(failed.state, "failed");
    assert.equal(failed.result, undefined);
    assert.equal(failed.error?.retryable, true);
    assert.deepEqual(await adapter.getSnapshot(), snapshot);
    assert.equal((await finish(adapter, await request())).state, "completed");
  }
});

test("empty state is coherent and returned data cannot mutate the adapter", async () => {
  const emptyAdapter = createDemoAdapter({ delayMs: 0, empty: true });
  const empty = await emptyAdapter.getSnapshot();
  assert.deepEqual(empty.totals, {
    conversationCount: 0,
    observedFrictionCount: 0,
    unclearCount: 0,
  });
  assert.deepEqual(empty.clusters, []);
  assert.deepEqual(empty.categories, []);
  assert.deepEqual(
    (await emptyAdapter.search({ snapshotId: empty.id, query: "travel" }))
      .clusterIds,
    [],
  );
  const result = await finish(
    emptyAdapter,
    (
      await emptyAdapter.createAnalysis({
        snapshotId: empty.id,
        intent: "usage",
      })
    ).runId,
  );
  if (result.state !== "completed" || result.result.kind !== "analysis")
    throw new Error("Missing empty analysis");
  assert.deepEqual(result.result.metrics, []);
  assert(!JSON.stringify(result).includes("NaN"));
  const adapter = createDemoAdapter({ delayMs: 0 });
  const snapshot = await adapter.getSnapshot();
  snapshot.clusters[0].metrics.conversationCount = 999;
  snapshot.clusters[0].needs.push("Unpublished mutation");
  const fresh = await adapter.getSnapshot();
  assert.equal(fresh.clusters[0].metrics.conversationCount, 108);
  assert(!fresh.clusters[0].needs.includes("Unpublished mutation"));
});
