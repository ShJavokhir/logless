// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Run, Snapshot } from "@/lib/types"
import { RunDetailsSheet } from "./RunDetailsSheet"

describe("run details missing receipts", () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  it.each([
    ["Execution evidence", "job did not start (image_missing)", "Runner did not start the job.", "not started"],
    ["Static pre-check", "disallowed import", "Static pre-check rejected the program", "pre-check"],
    ["Execution evidence", "execution could not be verified (runner_error)", "execution status is unknown", "no execution receipt"],
    ["Unknown", "", "execution status is unknown", "no execution receipt"],
  ])("uses failed %s evidence with detail %s", async (name, detail, message, label) => {
    const run = {
      run_id: "run_test", kind: "analysis", state: "failed", intent: null, stages: [],
      attempts_log: [1, 2].map((attempt) => ({
        program: "A", attempt, code: "pass", code_sha256: "12345678", receipt: null,
        verdict: { passed: false, checks: [{ name, passed: false, detail }] },
      })),
    } as unknown as Run
    const snapshot = { provenance: { models: {} } } as Snapshot
    await act(async () => root.render(createElement(RunDetailsSheet, { open: true, onOpenChange: () => {}, run, snapshot })))
    expect(document.body.textContent).toContain(message)
    expect(document.body.textContent).toContain(`Version 2 · ${label}`)
    if (name !== "Static pre-check") expect(document.body.textContent).not.toContain("Static pre-check rejected")
    if (label === "no execution receipt") expect(document.body.textContent).not.toContain("not started")
  })
})
