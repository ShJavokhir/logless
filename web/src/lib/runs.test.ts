import { describe, expect, it } from "vitest"
import { deriveSteps, hasVerifiedResult, runDurationMs, stageLabel } from "./runs"
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

describe("deriveSteps for questions", () => {
  it("adds Interpreting first for question runs", () => {
    const steps = deriveSteps({ state: "interpreting", attempts: 0, intent: "question", stages: [st("interpreting", "running", "t")] })
    expect(steps[0]).toMatchObject({ key: "interpreting", status: "running" })
    expect(deriveSteps(null, true)[0].key).toBe("interpreting")
    expect(deriveSteps(null)[0].key).toBe("planning")
  })
})

describe("deriveSteps with a pre-check repair", () => {
  it("shows Repairing when two program versions exist even with one execution", () => {
    const steps = deriveSteps({ state: "completed", attempts: 1, stages: [st("planning", "done", "t")], attempts_log: [{}, {}] as never })
    expect(steps.some((s) => s.key === "repairing")).toBe(true)
  })
  it("does not invent a repair when A and B each ran once", () => {
    const steps = deriveSteps({ state: "completed", attempts: 2, stages: [], attempts_log: [{ program: "A" }, { program: "B" }] as never })
    expect(steps.some((s) => s.key === "repairing")).toBe(false)
  })
})

describe("verified results", () => {
  const run = {
    state: "completed", snapshot_id: "current", result: { snapshot_id: "current" },
    verdict: { passed: true, checks: [{ name: "Schema", passed: true }] },
  } as Run
  it("requires a current result and explicit passing checks", () => {
    expect(hasVerifiedResult(run, "current")).toBe(true)
    expect(hasVerifiedResult(run, "newer")).toBe(false)
    expect(hasVerifiedResult({ ...run, result: null })).toBe(false)
    expect(hasVerifiedResult({ ...run, verdict: null })).toBe(false)
    expect(hasVerifiedResult({ ...run, verdict: { passed: true, checks: [] } })).toBe(false)
    expect(hasVerifiedResult({ ...run, verdict: { passed: true, checks: [{ name: "Failed", passed: false, detail: "" }] } })).toBe(false)
  })
  it("does not infer agreement from a completed two-program run", () => {
    const two = { ...run, attempts_log: [{ program: "A", verdict: { passed: true, checks: [] }, receipt: {} }, { program: "B", verdict: { passed: true, checks: [] }, receipt: {} }] } as unknown as Run
    expect(hasVerifiedResult(two)).toBe(false)
    expect(hasVerifiedResult({ ...two, verdict: { passed: true, checks: [{ name: "Two independent programs agree", passed: true, detail: "" }] } })).toBe(true)
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
