// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import type { SearchResponse, Snapshot } from "@/lib/types"
import { useSearch, SEARCH_DEBOUNCE_MS } from "./useSearch"

const snapshot = { snapshot_id: "old", clusters: [{ id: "leaf", parent_id: "category" }] } as Snapshot
const response = (query: string, snapshotId = "old"): SearchResponse => ({
  snapshot_id: snapshotId, query, elapsed_ms: 10, results: [{ cluster_id: "leaf", relevance: "relevant", p: 0.9 }],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe("semantic search request ownership", () => {
  let root: Root
  let result: ReturnType<typeof useSearch>
  function Harness({ data }: { data: Snapshot }) {
    const value = useSearch(data)
    useLayoutEffect(() => { result = value })
    return null
  }
  beforeEach(async () => {
    vi.useFakeTimers()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    root = createRoot(document.createElement("div"))
    await act(async () => root.render(createElement(Harness, { data: snapshot })))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  async function type(query: string) {
    await act(async () => result.setQuery(query))
  }
  async function debounce() {
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
  }
  it("ignores a late old response during the next query's debounce window", async () => {
    const first = deferred<SearchResponse>()
    const second = deferred<SearchResponse>()
    const search = vi.spyOn(api, "search").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await type("old query")
    await debounce()
    await type("new query")
    expect(search.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => first.resolve(response("old query")))
    expect(result.highlight.active).toBe(false)
    await debounce()
    await act(async () => second.resolve(response("new query")))
    expect(result.highlight.matchCount).toBe(1)
  })
  it("hides existing highlights immediately after typing or publishing a snapshot", async () => {
    vi.spyOn(api, "search").mockResolvedValue(response("query"))
    await type("query")
    await debounce()
    expect(result.highlight.active).toBe(true)
    await act(async () => root.render(createElement(Harness, { data: { ...snapshot, snapshot_id: "new" } })))
    expect(result.highlight.active).toBe(false)
    expect(result.elapsedMs).toBeNull()
    await debounce()
    expect(result.error).toContain("newer snapshot")
    expect(result.highlight.active).toBe(false)
  })
  it("clearing aborts the active request and drops late results", async () => {
    const pending = deferred<SearchResponse>()
    const search = vi.spyOn(api, "search").mockReturnValue(pending.promise)
    await type("query")
    await debounce()
    await act(async () => result.clear())
    expect(search.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => pending.resolve(response("query")))
    expect(result.highlight.active).toBe(false)
    expect(result.loading).toBe(false)
  })
})
