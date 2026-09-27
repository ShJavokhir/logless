import { useEffect, useRef } from "react"
import { CircleAlert, ExternalLink, FlaskConical, LayoutGrid, LoaderCircle, MessageSquareText, Rows3, Search, ShieldCheck, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Health, Snapshot } from "@/lib/types"
import { fmtDate, fmtDateRange, fmtInt } from "@/lib/format"
import { uniqueModelLabels } from "@/lib/snapshot"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Hint } from "./common"
import { ASK_LABEL, SANDBOX_UNAVAILABLE, conversationsPhrase, provenanceHint } from "@/lib/copy"

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-foreground" />
        <circle cx="13" cy="17" r="7" fill="none" className="stroke-background" strokeWidth="2.2" />
        <circle cx="21.5" cy="12" r="4" className="fill-background" />
      </svg>
      <span className="font-mono text-[15px] leading-none font-semibold tracking-[-0.03em]">logless</span>
    </span>
  )
}

export function Header({ snapshot }: { snapshot: Snapshot | null }) {
  const d = snapshot?.dataset
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2.5 lg:h-12 lg:flex-nowrap lg:py-0">
      <Wordmark />
      <Separator orientation="vertical" className="hidden h-5! lg:block" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px]">
        <span className="font-medium whitespace-nowrap">{snapshot?.workspace.name ?? "Loading workspace…"}</span>
        {d ? (
          <>
            <span className="whitespace-nowrap text-muted-foreground">{fmtDateRange(d.period_start, d.period_end)}</span>
            <span className="text-[12.5px] text-muted-foreground tabular-nums lg:whitespace-nowrap">
              {conversationsPhrase(d.conversations, d.fixtures, d.name)} · {fmtInt(d.users)} people · {fmtInt(d.languages)} languages
            </span>
          </>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Hint label={d ? provenanceHint(d.conversations, d.fixtures) : "No one can open a conversation here."} side="bottom">
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1.5 rounded-full border border-ok/25 bg-ok-soft px-2.5 text-[12px] font-medium whitespace-nowrap text-ok"
          >
            <ShieldCheck aria-hidden className="size-3.5" />
            Aggregate insights only
          </button>
        </Hint>
        {d?.source_url ? (
          <a
            href={d.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[12px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`${d.name}, ${d.license} licence (opens the dataset page)`}
          >
            {d.name} · {d.license}
            <ExternalLink aria-hidden className="size-3" />
          </a>
        ) : d ? (
          <span className="inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] whitespace-nowrap text-muted-foreground">
            {d.name} · {d.license}
          </span>
        ) : null}
      </div>
    </header>
  )
}

export type View = "map" | "list"

export function Toolbar({
  query,
  onQuery,
  onClear,
  searching,
  searchError,
  matchInfo,
  askOpen,
  asking,
  onOpenAsk,
  view,
  onView,
  disabled,
  notice,
}: {
  query: string
  onQuery: (q: string) => void
  onClear: () => void
  searching: boolean
  searchError: string | null
  matchInfo: { active: boolean; empty: boolean; count: number; partial: number }
  /** the ask card is open */
  askOpen: boolean
  /** a question run is in flight */
  asking: boolean
  /** open the answer card in "ask a question" mode */
  onOpenAsk: () => void
  view: View
  onView: (v: View) => void
  disabled: boolean
  notice?: React.ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  // "/" focuses search (when not typing elsewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <div className="relative w-full sm:w-[22rem]">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              onClear()
            }
          }}
          placeholder="Find a workflow…"
          aria-label="Find a workflow"
          aria-describedby="search-status"
          className="h-8 w-full rounded-lg border border-input bg-card pr-8 pl-8 text-[13.5px] shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-60 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        )}
      </div>

      <span id="search-status" role="status" aria-live="polite" className="text-[12.5px] text-muted-foreground sm:min-h-5">
        {searching ? (
          <span className="inline-flex items-center gap-1.5">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            Searching published insights…
          </span>
        ) : searchError ? (
          <span className="text-destructive">{searchError}</span>
        ) : matchInfo.active ? (
          matchInfo.empty ? (
            <span className="font-medium text-foreground">No matching published insights</span>
          ) : (
            <span>
              <span className="font-medium text-foreground">{matchInfo.count}</span> matching {matchInfo.count === 1 ? "workflow" : "workflows"}
              {matchInfo.partial ? <span> · {matchInfo.partial} possible</span> : null}
              <span className="text-subtle"> · Esc to clear</span>
            </span>
          )
        ) : null}
      </span>

      <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
        {notice}
        <Button onClick={onOpenAsk} aria-pressed={askOpen} aria-haspopup="dialog" disabled={disabled} className="h-8 px-3.5">
          {asking ? <LoaderCircle className="animate-spin" /> : <MessageSquareText />}
          {ASK_LABEL}
        </Button>
        <Separator orientation="vertical" className="mx-1 hidden h-5! sm:block" />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={view}
          disabled={disabled}
          onValueChange={(v) => v && onView(v as View)}
          aria-label="View"
        >
          <ToggleGroupItem value="map" aria-label="Map view" className="h-8 px-2.5 text-[12.5px]">
            <LayoutGrid />
            Map
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view" className="h-8 px-2.5 text-[12.5px]">
            <Rows3 />
            List
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  )
}

/** Inline status chip (no layout shift when health arrives late). */
export function HealthNotice({ health, error, snapshotId }: { health: Health | null; error: string | null; snapshotId?: string }) {
  const down = health?.sandbox === "unreachable" || !!error
  if (!down && health && snapshotId && health.snapshot_id && health.snapshot_id !== snapshotId) {
    return (
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-2.5 text-[12px] text-brand"
      >
        A newer snapshot is available · Reload
      </button>
    )
  }
  if (!down) return null
  return (
    <span role="status" className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warn/30 bg-warn-soft px-2.5 text-[12px] text-foreground/85">
      <CircleAlert aria-hidden className="size-3.5 shrink-0 text-warn" />
      {SANDBOX_UNAVAILABLE}
    </span>
  )
}

export function Footer({ snapshot, mock, onEval }: { snapshot: Snapshot | null; mock: boolean; onEval: () => void }) {
  const models = snapshot ? uniqueModelLabels(snapshot.provenance.models) : []
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-card px-4 py-2 text-[11px] text-muted-foreground lg:h-9 lg:flex-nowrap lg:py-0">
      <span className="min-w-0 lg:truncate">
        {snapshot ? (
          <>
            <span className="font-mono">Snapshot {snapshot.snapshot_id}</span> · map built by the logless pipeline {fmtDate(snapshot.created_at)}{" "}
            · models: {models.join(", ")}
          </>
        ) : (
          "Loading snapshot…"
        )}
      </span>
      {mock ? (
        <Hint label="The API is mocked in this build (VITE_MOCK). Numbers are illustrative, shaped like the WildChat sample.">
          <span tabIndex={0} className="inline-flex h-5 shrink-0 items-center rounded-full border border-dashed px-2 text-[11px] whitespace-nowrap">
            Mock API
          </span>
        </Hint>
      ) : null}
      <span className="flex shrink-0 items-center gap-3 lg:ml-auto">
        <Button variant="ghost" size="xs" onClick={onEval} disabled={!snapshot} className="text-[11.5px]">
          <FlaskConical />
          Evaluation
        </Button>
        {snapshot ? <span className="whitespace-nowrap" title={snapshot.dataset.attribution}>
          Data:{" "}
          {snapshot.dataset.source_url ? <a
            href={snapshot.dataset.source_url}
            target="_blank"
            rel="noreferrer"
            className={cn("underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground/40")}
          >
            {snapshot.dataset.name}
          </a> : snapshot.dataset.name}
          , {snapshot.dataset.license}
        </span> : null}
      </span>
    </footer>
  )
}
