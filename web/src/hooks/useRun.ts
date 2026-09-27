import { useEffect, useState } from "react"
import { api, describeError } from "@/lib/api"
import type { Run } from "@/lib/types"

export const POLL_MS = 1000

export function isTerminal(run: Run | null | undefined): boolean {
  return run?.state === "completed" || run?.state === "failed"
}

/**
 * Polls GET /api/runs/{id} once a second until the run completes or fails.
 * Requests never overlap; the poller stops on unmount or when the id changes.
 */
export function useRun(runId: string | null) {
  const [state, setState] = useState<{ id: string | null; run: Run | null; error: string | null }>({
    id: runId,
    run: null,
    error: null,
  })

  // Reset synchronously when the id changes (derived-state pattern).
  if (state.id !== runId) setState({ id: runId, run: null, error: null })

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ctrl = new AbortController()
    let failures = 0

    const tick = async () => {
      try {
        const run = await api.getRun(runId, ctrl.signal)
        if (cancelled) return
        failures = 0
        setState({ id: runId, run, error: null })
        if (!isTerminal(run)) timer = setTimeout(tick, POLL_MS)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return
        failures++
        // keep the last good run; surface the error after repeated failures
        if (failures >= 3) setState((s) => ({ ...s, error: describeError(err, "Lost contact with this run.") }))
        timer = setTimeout(tick, POLL_MS * Math.min(4, failures))
      }
    }
    void tick()
    return () => {
      cancelled = true
      ctrl.abort()
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  return { run: state.id === runId ? state.run : null, error: state.id === runId ? state.error : null }
}
