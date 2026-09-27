import assert from "node:assert/strict";
import test from "node:test";
import snapshotJson from "../../../web/src/mocks/real-snapshot.json";
import type { Snapshot as ApiSnapshot } from "../../../web/src/lib/types";
import { createLiveAdapter, LiveApiError, mapSnapshot } from "./live";

const source = snapshotJson as unknown as ApiSnapshot;
const id = source.snapshot_id;
const clusterId = source.clusters[0].id;
function stub(handler: (path: string, body: any) => unknown): typeof fetch {
  return (async (path, options) => new Response(JSON.stringify(handler(String(path), options?.body ? JSON.parse(String(options.body)) : undefined)), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("live snapshot retains published counts, four distinct signals, and evidence IDs", () => {
  const snapshot = mapSnapshot(source);
  assert.equal(snapshot.synthetic, false);
  assert.equal(snapshot.clusters.reduce((sum, node) => sum + node.metrics.conversationCount, 0), snapshot.totals.conversationCount);
  assert.equal(snapshot.clusters[0].metrics.signals.repeatRequests, source.clusters[0].friction.signals.repeat_request);
  assert.equal(snapshot.clusters[0].metrics.signals.assistantLimits, source.clusters[0].friction.signals.assistant_limit);
  assert.equal(snapshot.clusters[0].metrics.signals.unresolvedErrors, undefined);
  assert.equal(snapshot.clusters[0].evidence[0].id, source.clusters[0].needs![0].id);
});

test("live search excludes negative and uncertain classifications", async () => {
  const adapter = createLiveAdapter(stub((path, body) => {
    assert.equal(path, "/api/search"); assert.equal(body.snapshot_id, id);
    return { snapshot_id: id, query: body.query, elapsed_ms: 12, results: [
      { cluster_id: "yes", relevance: "relevant" }, { cluster_id: "maybe", relevance: "unclear" }, { cluster_id: "no", relevance: "not_relevant" },
    ] };
  }));
  assert.deepEqual((await adapter.search({ snapshotId: id, query: "coding" })).clusterIds, ["yes"]);
});

test("completed story runs fetch the published story cache instead of Run.result", async () => {
  let storyCalls = 0;
  const adapter = createLiveAdapter(stub((path) => {
    if (path.includes("/clusters/")) return ++storyCalls === 1 ? { status: "pending", run_id: "story-run" } : { status: "ready", story: { snapshot_id: id, cluster_id: clusterId, first_name: "Alex", text: "Alex wants help [n1].", citations: ["n1"], generated_at: "now" } };
    return { snapshot_id: id, state: "completed", attempts: 1, created_at: "then", updated_at: "now", result: null };
  }));
  const response = await adapter.requestStory({ snapshotId: id, clusterId });
  assert.equal(response.status, "pending");
  const run = await adapter.getRun("story-run");
  assert.equal(run.state, "completed");
  if (run.state !== "completed" || run.result.kind !== "story") throw new Error("missing story");
  assert.equal(run.result.story.name, "Alex"); assert.equal(run.result.story.simulated, false);
});

test("analysis uses question API and rejects a mismatched plan or failed gate", async () => {
  let passed = true;
  let signal: string | null = null;
  const adapter = createLiveAdapter(stub((path, body) => {
    if (path === "/api/snapshot") return source;
    if (path === "/api/analyses") { assert.equal(body.intent, "question"); return { run_id: "analysis" }; }
    return { snapshot_id: id, state: "completed", attempts: 2, created_at: "then", updated_at: "now", verdict: { passed }, result: { intent: "question", plan: { group_by: "leaf", scope_category_id: null, measure: "conversations", rank_by: "count", signal }, rows: [{ id: clusterId, count: 12, base: 12, share: 1 }] }, explanation: { text: "{{rows.0.id}}: {{rows.0.count}} conversations." } };
  }));
  await adapter.getSnapshot(); await adapter.createAnalysis({ snapshotId: id, intent: "usage" });
  const run = await adapter.getRun("analysis");
  assert.equal(run.state, "completed");
  if (run.state !== "completed" || run.result.kind !== "analysis") throw new Error("missing result");
  assert.equal(run.result.summary, `${source.clusters[0].title}: 12 conversations.`);
  signal = "any_friction";
  await assert.rejects(adapter.getRun("analysis"), /different question/);
  signal = null; passed = false;
  await assert.rejects(adapter.getRun("analysis"), /validated result/);
});

test("HTTP errors surface without substituting mock data", async () => {
  const adapter = createLiveAdapter((async () => new Response(JSON.stringify({ message: "A newer snapshot has been published." }), { status: 409 })) as typeof fetch);
  await assert.rejects(adapter.getSnapshot(), /newer snapshot/);
});

test("stale snapshot errors retain the code needed to load current insights", async () => {
  const adapter = createLiveAdapter((async () => new Response(JSON.stringify({ code: "stale_snapshot", message: "Reload the page." }), { status: 409 })) as typeof fetch);
  await assert.rejects(adapter.search({ snapshotId: id, query: "coordination" }), (error: unknown) => error instanceof LiveApiError && error.code === "stale_snapshot");
});
