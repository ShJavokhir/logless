import { describe, expect, it } from "vitest"
import { deriveSteps, runDurationMs, stageLabel } from "./runs"
import type { Run, RunStage } from "./types"

const st = (name: string, status: RunStage["status"], a: string | null = null, b: string | null = null): RunStage => ({
  name,
  status,
  started_at: a,
  finished_at: b,
  detail: null,
})

describe("deriveSteps", () => {
  it("shows four steps for a plain run and tracks the running one", () => {
    const steps = deriveSteps({
      state: "executing",
      attempts: 1,
      stages: [st("planning", "done", "t"), st("executing", "running", "t"), st("validating", "pending"), st("explaining", "pending")],
    })
    expect(steps.map((s) => s.key)).toEqual(["planning", "executing", "validating", "explaining"])
    expect(steps.map((s) => s.status)).toEqual(["done", "running", "pending", "pending"])
  })

  it("adds Repairing and uses the latest started stage of each name", () => {
    const steps = deriveSteps({
      state: "repairing",
      attempts: 1,
      stages: [
        st("planning", "done", "t"),
        st("executing", "done", "t"),
        st("validating", "failed", "t"),
        st("repairing", "running", "t"),
        st("executing", "pending"),
        st("validating", "pending"),
        st("explaining", "pending"),
      ],
    })
    expect(steps.map((s) => s.key)).toEqual(["planning", "executing", "validating", "repairing", "explaining"])
    expect(steps.find((s) => s.key === "validating")?.status).toBe("failed")
    expect(steps.find((s) => s.key === "repairing")?.status).toBe("running")
  })

  it("marks never-started steps as skipped when the run failed", () => {
    const steps = deriveSteps({ state: "failed", attempts: 2, stages: [st("planning", "done", "t"), st("validating", "failed", "t")] })
    expect(steps.find((s) => s.key === "explaining")?.status).toBe("skipped")
  })

  it("handles a missing run", () => {
    expect(deriveSteps(null).every((s) => s.status === "pending")).toBe(true)
  })
})

describe("runDurationMs / stageLabel", () => {
  it("measures from the first start to the last finish", () => {
    const run = {
      stages: [st("planning", "done", "2026-09-27T00:00:00.000Z", "2026-09-27T00:00:01.000Z"), st("explaining", "done", "2026-09-27T00:00:01.000Z", "2026-09-27T00:00:05.900Z")],
    } as Run
    expect(runDurationMs(run)).toBe(5900)
  })
  it("labels known and unknown stages", () => {
    expect(stageLabel("leak_attempt")).toBe("Leak attempt")
    expect(stageLabel("new_stage")).toBe("New stage")
  })
})
