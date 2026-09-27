// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "@/lib/api"
import type { IntakeEventsResponse, Run, Snapshot } from "@/lib/types"
import { useIntake } from "./useIntake"

const snapshot = { snapshot_id: "base" } as Snapshot
const complete: IntakeEventsResponse = {
  run_id: "intake", state: "completed", stage: "done", events: [],
  counters: { decided: 0, total: 0, per_second: 0, p50_ms: 0, decisions_per_conversation: 5 },
}
const finished = { intake: { published_snapshot_id: "expected", base_snapshot_id: "base", decided: 0, deltas: [] } } as unknown as Run

describe("intake publication ownership", () => {
  let root: Root
  let result: ReturnType<typeof useIntake>
  const onPublished = vi.fn()
  function Harness() {
    const value = useIntake(snapshot, onPublished)
    useLayoutEffect(() => { result = value })
    return null
  }
  beforeEach(async () => {
    vi.useFakeTimers()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    onPublished.mockClear()
    vi.spyOn(api, "startIntake").mockResolvedValue({ run_id: "intake" })
    vi.spyOn(api, "getIntakeStatus").mockResolvedValue({ ready: false, base_snapshot_id: "base", batch_size: 0 })
    vi.spyOn(api, "getRun").mockResolvedValue(finished)
    root = createRoot(document.createElement("div"))
    await act(async () => root.render(createElement(Harness)))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }
  it("waits for the exact published snapshot and prevents early dismissal", async () => {
    vi.spyOn(api, "getIntakeEvents").mockResolvedValue(complete)
    vi.spyOn(api, "getSnapshot")
      .mockResolvedValueOnce({ snapshot_id: "unrelated" } as Snapshot)
      .mockResolvedValue({ snapshot_id: "expected" } as Snapshot)
    await act(async () => result.start())
    await advance(100)
    expect(result.phase).toBe("done")
    expect(result.published).toBe(false)
    expect(onPublished).not.toHaveBeenCalled()
    await act(async () => result.close())
    expect(result.phase).toBe("done")
    await advance(500)
    expect(result.published).toBe(true)
    expect(onPublished).toHaveBeenCalledExactlyOnceWith({ snapshot_id: "expected" })
  })
  it("stops polling after presenter access is rejected", async () => {
    const events = vi.spyOn(api, "getIntakeEvents").mockRejectedValue(new ApiError(403, "presenter_required", "Presenter required"))
    await act(async () => result.start())
    await advance(5000)
    expect(result.phase).toBe("failed")
    expect(result.error).toBe("Live intake is presenter-only.")
    expect(events).toHaveBeenCalledTimes(1)
  })
  it("clears a transient polling error after recovery", async () => {
    vi.spyOn(api, "getIntakeEvents").mockRejectedValueOnce(new ApiError(0, "network", "Offline")).mockResolvedValue(complete)
    vi.spyOn(api, "getSnapshot").mockResolvedValue({ snapshot_id: "expected" } as Snapshot)
    await act(async () => result.start())
    expect(result.error).toContain("could not be reached")
    await advance(1000)
    expect(result.error).toBeNull()
    expect(result.published).toBe(true)
  })
})
