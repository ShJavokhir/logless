import { describe, expect, it } from "vitest"
import { agentPrompt, stripCitations } from "./agentPrompt"
import type { Node as SnapshotNode, Prd, Snapshot } from "./types"

const leaf = {
  id: "cl_aaaaaa",
  title: "Debugging code",
  description: "People paste errors and ask for fixes.",
  conversations: 400,
  users: 250,
  friction: { conversations: 120, share: 0.3, unclear: 4, signals: { correction: 90, repeat_request: 40, assistant_limit: 0, complaint: 5 } },
  needs: [{ id: "n1", text: "Fix errors" }],
  problems: [{ id: "p1", text: "Wrong fixes", signal: "correction", support: "common" }, { id: "p2", text: "Uncited", signal: null, support: "observed" }],
} as unknown as SnapshotNode

const snapshot = { totals: { conversations: 5000 } } as unknown as Snapshot

const prd: Prd = {
  cluster_id: "cl_aaaaaa",
  snapshot_id: "snap_x",
  label: "Draft PRD · test",
  title: "Verified fixes",
  problem: "Wrong fixes [p1].",
  user_stories: ["As a user, I want fixes so that I stop retrying [n1]."],
  requirements: ["Run fixes first [p1]."],
  success_metrics: ["Corrections fall below 120."],
  citations: ["p1", "n1"],
  metrics_used: [],
  priority: { level: "P0", rank: 2, of: 30, basis: "Ranks 2 of 30." },
  model: "glm-5.3",
  generated_at: "2026-09-27T14:00:00Z",
}

describe("stripCitations", () => {
  it("drops the chips and keeps punctuation tight", () => {
    expect(stripCitations("Wrong fixes [p1]. And more [n2] [p3], then done")).toBe("Wrong fixes. And more, then done")
  })
})

describe("agentPrompt", () => {
  const text = agentPrompt(prd, leaf, snapshot)
  it("carries the published numbers, most frequent signal first", () => {
    expect(text).toContain("400 of 5,000 conversations (250 people)")
    expect(text).toContain("120 (30.0%) show friction: correction 90, repeated request 40, complaint 5.")
    expect(text).not.toContain("assistant limit")
    expect(text).toContain("Priority: P0, rank 2 of 30.")
  })
  it("lists PRD sections without citation chips, and only cited evidence", () => {
    expect(text).toContain("## User stories\n- As a user, I want fixes so that I stop retrying.")
    expect(text).toContain("## Done when\n- Corrections fall below 120.")
    expect(text).toContain("- Fix errors\n- Wrong fixes")
    expect(text).not.toContain("Uncited")
    expect(text).not.toMatch(/\[[np]\d\]/)
  })
})
