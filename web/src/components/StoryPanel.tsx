import { useCallback, useEffect, useRef, useState } from "react"
import { BookOpen, LoaderCircle, RotateCcw } from "lucide-react"
import { api, describeError } from "@/lib/api"
import type { Node as SnapshotNode, Story } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { STORY_LABEL } from "@/lib/copy"
import { splitCitations } from "@/lib/citations"
import { fmtClock } from "@/lib/format"
import { useRun } from "@/hooks/useRun"
import { Button } from "@/components/ui/button"
import { EvidenceTag } from "./common"

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "pending"; runId: string }
  | { kind: "ready"; story: Story }
  | { kind: "error"; message: string }

// Stories survive re-selection within a session (keyed by snapshot + cluster).
const cache = new Map<string, Story>()

export function StoryPanel({
  index,
  leaf,
  onHoverCitation,
}: {
  index: SnapshotIndex
  leaf: SnapshotNode
  onHoverCitation: (id: string | null) => void
}) {
  const snapshotId = index.snapshot.snapshot_id
  const key = `${snapshotId}:${leaf.id}`
  const [phase, setPhase] = useState<Phase>(() => {
    const cached = cache.get(key)
    return cached ? { kind: "ready", story: cached } : { kind: "idle" }
  })
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
    (res: Awaited<ReturnType<typeof api.requestStory>>) => {
      if (res.status === "ready") {
        cache.set(key, res.story)
        setPhase({ kind: "ready", story: res.story })
      } else {
        setPhase({ kind: "pending", runId: res.run_id })
      }
    },
    [key],
  )
  const fail = useCallback((err: unknown) => setPhase({ kind: "error", message: describeError(err, "The story could not be generated.") }), [])

  // When the story run completes, ask again for the ready story (an external
  // fetch, so an effect is the right place). A failed run is derived in render.
  const completedRunId = run?.state === "completed" ? run.run_id : null
  useEffect(() => {
    if (!completedRunId || completedRunId !== pendingId) return
    let cancelled = false
    api.requestStory(leaf.id, snapshotId).then(
      (res) => !cancelled && apply(res),
      (err) => !cancelled && fail(err),
    )
    return () => {
      cancelled = true
    }
  }, [completedRunId, pendingId, leaf.id, snapshotId, apply, fail])

  const request = () => {
    setPhase({ kind: "requesting" })
    api.requestStory(leaf.id, snapshotId).then(
      (res) => alive.current && apply(res),
      (err) => alive.current && fail(err),
    )
  }

  if (phase.kind === "ready") {
    return <StoryCard story={phase.story} leaf={leaf} onHoverCitation={onHoverCitation} />
  }

  const runFailed = phase.kind === "pending" && run?.state === "failed"
  const errorMessage =
    phase.kind === "error" ? phase.message : runFailed ? (run?.error?.message ?? "The story could not be generated.") : runError
  const busy = (phase.kind === "requesting" || phase.kind === "pending") && !runFailed
  const liveStage = run?.stages.find((s) => s.status === "running")

  return (
    <section aria-labelledby="story-h" className="rounded-xl border border-dashed p-4">
      <div className="flex flex-col gap-3">
        <div>
          <h3 id="story-h" className="text-[13.5px] font-medium">
            Make this pattern tangible
          </h3>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            Writes an invented person's story from this cluster's generalized needs and problems only — no conversation is read.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={request} disabled={busy} aria-busy={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : errorMessage ? <RotateCcw /> : <BookOpen />}
            {errorMessage && !busy ? "Try again" : "Generate fictional user story"}
          </Button>
          <span role="status" aria-live="polite" className="text-[12px] text-muted-foreground">
            {busy ? (liveStage?.detail ?? "Starting…") : null}
          </span>
        </div>
        {errorMessage ? (
          <p role="alert" className="text-[12.5px] text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function StoryCard({ story, leaf, onHoverCitation }: { story: Story; leaf: SnapshotNode; onHoverCitation: (id: string | null) => void }) {
  const known = new Set([...(leaf.needs ?? []), ...(leaf.problems ?? [])].map((x) => x.id))
  return (
    <section aria-labelledby="story-card-h" className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex items-start gap-2 border-b bg-warn-soft px-4 py-2.5 text-[12px] leading-snug text-foreground/80">
        <BookOpen aria-hidden className="mt-px size-3.5 shrink-0 text-warn" />
        <p>
          <span className="font-semibold text-foreground">Fictional user story</span>
          {" · "}
          {STORY_LABEL.split(" · ")[1]}
        </p>
      </div>
      <div className="px-4 pt-3.5 pb-4">
        <h3 id="story-card-h" className="mb-1.5 text-[13.5px] font-medium">
          {story.first_name} <span className="font-normal text-muted-foreground">(invented)</span>
        </h3>
        <p className="font-serif text-[14px] leading-[1.6] text-foreground/90">
          {splitCitations(story.text).map((part, i) =>
            part.kind === "text" ? (
              <span key={i}>{part.text}</span>
            ) : (
              <button
                key={i}
                type="button"
                className="mr-px ml-1 rounded-[4px] align-[1px]"
                onMouseEnter={() => onHoverCitation(part.id)}
                onMouseLeave={() => onHoverCitation(null)}
                onFocus={() => onHoverCitation(part.id)}
                onBlur={() => onHoverCitation(null)}
                aria-label={`Evidence ${part.id}`}
              >
                <EvidenceTag id={part.id} className={known.has(part.id) ? undefined : "line-through"} />
              </button>
            ),
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span>Draws on</span>
          {story.citations.map((c) => (
            <button
              key={c}
              type="button"
              className="rounded-[4px]"
              onMouseEnter={() => onHoverCitation(c)}
              onMouseLeave={() => onHoverCitation(null)}
              onFocus={() => onHoverCitation(c)}
              onBlur={() => onHoverCitation(null)}
              aria-label={`Evidence ${c}${known.has(c) ? "" : " (not in this cluster)"}`}
            >
              <EvidenceTag id={c} className={known.has(c) ? undefined : "line-through"} />
            </button>
          ))}
          <span className="ml-auto font-mono text-[10.5px]">
            {story.model} · {fmtClock(story.generated_at)} UTC
          </span>
        </div>
      </div>
    </section>
  )
}
