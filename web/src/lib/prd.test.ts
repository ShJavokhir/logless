import { describe, expect, it } from "vitest"
import { prdMarkdown } from "./prd"
import type { Node as SnapshotNode, Prd } from "./types"

const leaf = {
  id: "cl_aaaaaa",
  title: "Debugging code",
  needs: [{ id: "n1", text: "Fix errors" }],
  problems: [{ id: "p1", text: "Wrong fixes", signal: "correction", support: "common" }],
} as unknown as SnapshotNode

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
  metrics_used: [{ name: "correction", value: "120" }],
  priority: { level: "P0", rank: 2, of: 30, basis: "Ranks 2 of 30." },
  model: "glm-5.3",
  generated_at: "2026-09-27T14:00:00Z",
}

describe("prdMarkdown", () => {
  it("renders every section and resolves evidence to published text", () => {
    const md = prdMarkdown(prd, leaf)
    expect(md).toContain("# Verified fixes")
    expect(md).toContain("**Priority:** P0 (rank 2 of 30)")
    expect(md).toContain("## User stories\n- As a user, I want fixes")
    expect(md).toContain("- [n1] Fix errors")
    expect(md).toContain("- [p1] Wrong fixes")
    expect(md).toContain("Correction: 120")
  })
})
