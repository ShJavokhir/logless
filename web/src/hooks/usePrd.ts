import { useCallback, useEffect, useRef, useState } from "react"
import { api, describeError } from "@/lib/api"
import type { Prd, Run } from "@/lib/types"
import { useRun } from "./useRun"

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "pending"; runId: string }
  | { kind: "ready"; prd: Prd }
  | { kind: "error"; message: string }

// PRDs survive re-selection within a session (keyed by snapshot + cluster).
const cache = new Map<string, Prd>()

export type PrdState = {
  prd: Prd | null
  busy: boolean
  error: string | null
  /** the PRD run, while it is drafting */
  run: Run | null
  request: () => void
}

/** Requests a workflow's PRD (POST /clusters/{id}/prd), follows its run, and re-fetches the ready draft. */
export function usePrd(snapshotId: string, leafId: string): PrdState {
  const key = `${snapshotId}:${leafId}`
  const initial = (): Phase => {
    const cached = cache.get(key)
    return cached ? { kind: "ready", prd: cached } : { kind: "idle" }
  }
  const [state, setState] = useState<{ key: string; phase: Phase }>(() => ({ key, phase: initial() }))
  if (state.key !== key) setState({ key, phase: initial() })
  const phase = state.key === key ? state.phase : initial()
  const setPhase = useCallback((p: Phase) => setState({ key, phase: p }), [key])

  const pendingId = phase.kind === "pending" ? phase.runId : null
  const { run, error: runError } = useRun(pendingId)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const apply = useCallback(
    (res: Awaited<ReturnType<typeof api.requestPrd>>) => {
      if (res.status === "ready") {
        cache.set(key, res.prd)
        setPhase({ kind: "ready", prd: res.prd })
      } else {
        setPhase({ kind: "pending", runId: res.run_id })
      }
    },
    [key, setPhase],
  )
  const fail = useCallback((err: unknown) => setPhase({ kind: "error", message: describeError(err, "The PRD could not be drafted.") }), [setPhase])

  // When the PRD run completes, ask again for the ready draft. A failed run is derived below.
  const completedRunId = run?.state === "completed" ? run.run_id : null
  useEffect(() => {
    if (!completedRunId || completedRunId !== pendingId) return
    let cancelled = false
    api.requestPrd(leafId, snapshotId).then(
      (res) => !cancelled && apply(res),
      (err) => !cancelled && fail(err),
    )
    return () => {
      cancelled = true
    }
  }, [completedRunId, pendingId, leafId, snapshotId, apply, fail])

  const request = useCallback(() => {
    setPhase({ kind: "requesting" })
    api.requestPrd(leafId, snapshotId).then(
      (res) => alive.current && apply(res),
      (err) => alive.current && fail(err),
    )
  }, [leafId, snapshotId, apply, fail, setPhase])

  const runFailed = phase.kind === "pending" && run?.state === "failed"
  const error = phase.kind === "error" ? phase.message : runFailed ? (run?.error?.message ?? "The PRD could not be drafted.") : runError
  return {
    prd: phase.kind === "ready" ? phase.prd : null,
    busy: (phase.kind === "requesting" || phase.kind === "pending") && !runFailed && !runError,
    error,
    run: phase.kind === "pending" ? run : null,
    request,
  }
}
