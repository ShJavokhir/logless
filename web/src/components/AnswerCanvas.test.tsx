// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { canvasSpec, type CanvasCandidate, type CanvasResponse } from "@/lib/canvas"
import { indexSnapshot } from "@/lib/snapshot"
import { questionResult } from "@/mocks/results"
import snapshotJson from "@/mocks/snapshot.json"
import type { Run, Snapshot } from "@/lib/types"
import { AnswerCanvas } from "./AnswerCanvas"

const snapshot = snapshotJson as unknown as Snapshot
const index = indexSnapshot(snapshot)
const result = questionResult(snapshot, { group_by: "leaf", scope_category_id: null, measure: "conversations", signal: null, rank_by: "count", limit: 3 })
const run = { run_id: "run_canvas_test", snapshot_id: snapshot.snapshot_id } as Run
const response = (selected: CanvasCandidate[], status: CanvasResponse["status"] = "composed"): CanvasResponse => ({
  run_id: run.run_id, snapshot_id: run.snapshot_id, selected, status, spec: canvasSpec(selected),
})
afterEach(() => vi.restoreAllMocks())

describe("generated answer interaction", () => {
  it("renders checked data, follows links, edits and restores a previous view", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const compose = vi.spyOn(api, "composeCanvas").mockResolvedValueOnce(response(["cards"]))
      .mockResolvedValueOnce(response(["friction", "signals"]))
    const container = document.createElement("div")
    const root = createRoot(container)
    const open = vi.fn()
    try {
      await act(async () => root.render(<StrictMode><AnswerCanvas run={run} result={result} index={index} ranking={<p>Checked ranking</p>} open={open} /></StrictMode>))
      expect(compose).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain(index.byId.get(result.rows[0].id)!.description)
      const firstCard = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(index.byId.get(result.rows[0].id)!.title))!
      await act(async () => firstCard.click())
      expect(open).toHaveBeenCalledWith(result.rows[0].id)
      await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Compare friction")!.click())
      expect(compose.mock.calls[1][0].previous).toEqual(["cards"])
      expect(container.querySelector("svg[aria-label='Workflow conversation volume versus observed friction rate']")).not.toBeNull()
      expect(container.textContent).toContain("How friction shows up")
      await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Previous view"))!.click())
      expect(container.textContent).toContain("What people are doing")
      expect(container.textContent).not.toContain("How friction shows up")
    } finally { await act(async () => root.unmount()) }
  })

  it("keeps the checked ranking when an API response injects data", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const invalid = response(["cards"])
    invalid.spec.elements.cards.props = { count: "invented" }
    vi.spyOn(api, "composeCanvas").mockResolvedValue(invalid)
    const container = document.createElement("div")
    const root = createRoot(container)
    try {
      await act(async () => root.render(<AnswerCanvas run={run} result={result} index={index} ranking={<p>Checked ranking</p>} open={() => {}} />))
      expect(container.textContent).toContain("Checked ranking")
      expect(container.textContent).not.toContain("What people are doing")
    } finally { await act(async () => root.unmount()) }
  })

  it("preserves the current view when edits require analysis or the provider fails", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, "composeCanvas").mockResolvedValueOnce(response(["cards"]))
      .mockResolvedValueOnce(response(["ranking"], "needs_analysis"))
      .mockResolvedValueOnce(response(["ranking"], "fallback"))
    const container = document.createElement("div")
    const root = createRoot(container)
    try {
      await act(async () => root.render(<AnswerCanvas run={run} result={result} index={index} ranking={<p>Checked ranking</p>} open={() => {}} />))
      const edit = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Compare friction")!.click()
      await act(async () => edit())
      expect(container.textContent).toContain("That changes the analysis")
      expect(container.textContent).toContain("What people are doing")
      await act(async () => edit())
      expect(container.textContent).toContain("Jev could not update the view")
      expect(container.textContent).toContain("What people are doing")
    } finally { await act(async () => root.unmount()) }
  })
})
