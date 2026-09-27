import { useEffect, useRef, useState } from "react"
import { api, describeError } from "@/lib/api"
import { validateCanvas, type CanvasRequest, type CanvasResponse } from "@/lib/canvas"

// StrictMode/remounts share an in-flight composition rather than spending twice.
const pending = new Map<string, Promise<CanvasResponse>>()
function compose(request: CanvasRequest) {
  const key = JSON.stringify(request)
  const existing = pending.get(key)
  if (existing) return existing
  const promise = api.composeCanvas(request).then((value) => {
    try { return validateCanvas(value, request) }
    catch { throw new Error("The generated view could not be checked. Your answer is still available.") }
  })
    .finally(() => pending.delete(key))
  pending.set(key, promise)
  return promise
}

export function useCanvas(runId: string, snapshotId: string) {
  const [versions, setVersions] = useState<CanvasResponse[]>([])
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const sequence = useRef(0)
  const current = versions.at(-1)

  useEffect(() => {
    let disposed = false
    const seq = ++sequence.current
    compose({ run_id: runId, snapshot_id: snapshotId, instruction: "", previous: [] }).then((value) => {
      if (!disposed && seq === sequence.current) setVersions([value])
    }).catch((error) => {
      if (!disposed && seq === sequence.current) setNotice(describeError(error))
    }).finally(() => { if (!disposed && seq === sequence.current) setBusy(false) })
    // This ref is an async ownership counter, not a DOM ref. Invalidate edits
    // too, so an unmounted answer cannot publish a late response.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    return () => { disposed = true; sequence.current++ }
  }, [runId, snapshotId])

  async function reshape(instruction: string) {
    const seq = ++sequence.current
    setBusy(true)
    setNotice(null)
    try {
      const value = await compose({ run_id: runId, snapshot_id: snapshotId, instruction, previous: current?.selected ?? [] })
      if (seq !== sequence.current) return
      if (value.status === "needs_analysis") {
        setNotice("That changes the analysis. Use Ask another to ask a complete question; this view still shows the current answer.")
      } else if (value.status === "fallback") {
        setNotice("Jev could not update the view. Your previous view is still shown. Try again.")
      } else {
        setVersions((old) => [...old.slice(-9), value])
      }
    } catch (error) {
      if (seq === sequence.current) setNotice(describeError(error))
    } finally {
      if (seq === sequence.current) setBusy(false)
    }
  }
  return { current, busy, notice, reshape, canGoBack: versions.length > 1,
    back: () => { if (!busy) { setVersions((old) => old.slice(0, -1)); setNotice(null) } } }
}
