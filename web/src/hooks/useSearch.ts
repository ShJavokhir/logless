import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, api, describeError } from "@/lib/api"
import { createLatestGuard, highlightFromResults, NO_HIGHLIGHT, type HighlightState } from "@/lib/search"
import type { SearchResponse, Snapshot } from "@/lib/types"

export const SEARCH_DEBOUNCE_MS = 300

/**
 * Debounced semantic search. Only the latest response is applied; clearing
 * the query drops any in-flight response.
 */
export function useSearch(snapshot: Snapshot | null) {
  const [query, setQuery] = useState("")
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guard = useRef(createLatestGuard())
  const ctrl = useRef<AbortController | null>(null)

  const trimmed = query.trim()

  useEffect(() => {
    if (!snapshot) return
    if (!trimmed) {
      guard.current.invalidate()
      ctrl.current?.abort()
      return
    }
    const timer = setTimeout(async () => {
      const token = guard.current.begin()
      ctrl.current?.abort()
      const c = new AbortController()
      ctrl.current = c
      setLoading(true)
      setError(null)
      try {
        const res = await api.search({ query: trimmed.slice(0, 200), snapshot_id: snapshot.snapshot_id }, c.signal)
        if (!guard.current.isCurrent(token)) return
        setResponse(res)
      } catch (err) {
        if (!guard.current.isCurrent(token)) return
        if (err instanceof DOMException && err.name === "AbortError") return
        setError(
          err instanceof ApiError && err.code === "budget_exhausted"
            ? "Search is paused: the demo's model budget is used up."
            : describeError(err, "Search is unavailable right now."),
        )
        setResponse(null)
      } finally {
        if (guard.current.isCurrent(token)) setLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmed, snapshot])

  // Typing back to an empty query drops any in-flight response immediately.
  const updateQuery = useCallback((q: string) => {
    setQuery(q)
    if (!q.trim()) {
      guard.current.invalidate()
      ctrl.current?.abort()
      setLoading(false)
      setError(null)
    }
  }, [])

  const clear = useCallback(() => {
    guard.current.invalidate()
    ctrl.current?.abort()
    setQuery("")
    setResponse(null)
    setLoading(false)
    setError(null)
  }, [])

  const highlight: HighlightState = useMemo(() => {
    if (!snapshot || !trimmed || !response) return NO_HIGHLIGHT
    return highlightFromResults(response, snapshot.clusters)
  }, [snapshot, trimmed, response])

  return {
    query,
    setQuery: updateQuery,
    clear,
    highlight,
    loading: !!trimmed && loading,
    error: trimmed ? error : null,
    elapsedMs: response?.elapsed_ms ?? null,
  }
}
