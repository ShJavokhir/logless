import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Run } from "@/lib/types"
import { AgentLoop } from "./AgentLoop"

describe("agent loop evidence", () => {
  it("does not invent agreement or gVisor execution from completed stages", () => {
    const run = {
      state: "completed", attempts: 2,
      stages: ["planning", "executing", "validating", "explaining"].map((name) => ({ name, status: "done" })),
      attempts_log: ["A", "B"].map((program) => ({
        program, attempt: 1, code_sha256: "12345678", receipt: { runtime: "runc", elapsed_ms: 5 },
        verdict: { passed: true, checks: [{ name: "Schema", passed: true }] },
      })),
      verdict: { passed: true, checks: [] },
    } as unknown as Run
    const html = renderToStaticMarkup(createElement(AgentLoop, { run }))
    expect(html).not.toContain("Programs agree")
    expect(html).not.toContain("identical")
    expect(html).not.toContain("gVisor")
    expect(html).toContain("Agreement check")
    expect(html).toContain("Ran both in sandbox")
  })
  it("does not label a runner failure or unknown receipt as a static rejection", () => {
    for (const [detail, expected] of [
      ["job did not start (image_missing)", "was not started by the runner"],
      ["execution could not be verified (runner_error)", "has no execution receipt"],
    ]) {
      const run = {
        state: "failed", attempts: 0, stages: [],
        attempts_log: [1, 2].map((attempt) => ({
          program: "A", attempt, code_sha256: "12345678", receipt: null,
          verdict: { passed: false, checks: [{ name: "Execution evidence", passed: false, detail }] },
        })),
      } as unknown as Run
      const html = renderToStaticMarkup(createElement(AgentLoop, { run }))
      expect(html).toContain(expected)
      expect(html).not.toContain("static pre-check")
      expect(html).not.toContain("not run")
    }
  })
})
