// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import type { EvalReport } from "@/lib/types"
import { EvalDialog } from "./EvalDialog"

const report = (snapshot_id: string): EvalReport => ({ snapshot_id, generated_at: "2026-09-26T12:00:00Z", checks: [] })

describe("evaluation snapshot ownership", () => {
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
    vi.restoreAllMocks()
  })
  async function show(snapshotId: string, open = true) {
    await act(async () => root.render(createElement(EvalDialog, { snapshotId, open, onOpenChange: () => {} })))
  }
  it("does not show a previous snapshot's evaluation after intake", async () => {
    vi.spyOn(api, "getEval").mockResolvedValue(report("old"))
    await show("old")
    expect(document.body.textContent).toContain("0 of 0 targets met")
    await show("new")
    expect(document.body.textContent).not.toContain("0 of 0 targets met")
    expect(document.body.textContent).toContain("report for this snapshot is not ready")
  })
  it("refreshes on reopen so a newly generated evaluation can replace an earlier result", async () => {
    const getEval = vi.spyOn(api, "getEval").mockResolvedValue(report("old"))
    await show("old")
    await show("old", false)
    await show("old")
    expect(getEval).toHaveBeenCalledTimes(2)
  })
})
