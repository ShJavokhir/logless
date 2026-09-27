import { useCallback, useEffect, useMemo, useState } from "react"
import { ApiError, api, describeError } from "@/lib/api"
import { highlightFromResults, NO_HIGHLIGHT, type HighlightState } from "@/lib/search"
import type { SearchResponse, Snapshot } from "@/lib/types"

export const SEARCH_DEBOUNCE_MS = 300

/**
 * Debounced semantic search. Only the latest response is applied; clearing
 * the query drops any in-flight response.
 */
export function useSearch(snapshot: Snapshot | null) {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<{
    query: string
    snapshotId: string
    response: SearchResponse | null
    loading: boolean
    error: string | null
  } | null>(null)

  const trimmed = query.trim().slice(0, 200)
  const snapshotId = snapshot?.snapshot_id

  useEffect(() => {
    if (!snapshotId || !trimmed) return
    let cancelled = false
    const ctrl = new AbortController()
    const scope = { query: trimmed, snapshotId }
    const timer = setTimeout(async () => {
      setState({ ...scope, response: null, loading: true, error: null })
      try {
        const res = await api.search({ query: trimmed, snapshot_id: snapshotId }, ctrl.signal)
        if (cancelled) return
        if (res.snapshot_id !== snapshotId) throw new ApiError(409, "stale_snapshot", "Search returned another snapshot.")
        setState({ ...scope, response: res, loading: false, error: null })
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return
        setState({
          ...scope,
          response: null,
          loading: false,
          error: err instanceof ApiError && err.code === "budget_exhausted"
            ? "Search is paused: the demo's model budget is used up."
            : describeError(err, "Search is unavailable right now."),
        })
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [trimmed, snapshotId])

  const clear = useCallback(() => {
    setQuery("")
    setState(null)
  }, [])

  // Hide old results immediately, including the debounce interval before the
  // next request starts and the render when a new snapshot is published.
  const current = trimmed && state?.query === trimmed && state.snapshotId === snapshotId ? state : null
  const response = current?.response ?? null
  const highlight: HighlightState = useMemo(() => {
    if (!snapshot || !trimmed || !response) return NO_HIGHLIGHT
    return highlightFromResults(response, snapshot.clusters)
  }, [snapshot, trimmed, response])

  return {
    query,
    setQuery,
    clear,
    highlight,
    loading: current?.loading ?? false,
    error: current?.error ?? null,
    elapsedMs: response?.elapsed_ms ?? null,
  }
}
