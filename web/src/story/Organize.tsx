import { useState } from "react"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { ProvenanceStage } from "@/lib/types"
import { fmtInt } from "@/lib/format"
import { modelLabel } from "@/lib/snapshot"
import { DetailPanel } from "@/components/DetailPanel"
import { UsageMap, type Lens } from "@/components/UsageMap"
import { NO_HIGHLIGHT } from "@/lib/search"
import { Walkthrough } from "./Walkthrough"
import { ModelChip } from "./ModelChip"
import { askFromStory } from "./handoff"
import { Lead } from "./Lead"

export function Organize({ index, beat }: { index: SnapshotIndex; beat: number; onBeat: (b: number) => void }) {
  if (beat === 0) return <Walkthrough index={index} />
  if (beat === 1) return <Funnel index={index} />
  return <MapBeat index={index} />
}

// ---------------------------------------------------------------- all conversations

type Row = {
  key: string
  value: number | null
  unit: string
  title: string
  detail: string[]
  models: string[]
}

const n = (s: ProvenanceStage | undefined, k: string): number | null => {
  const v = s?.counts?.[k]
  return typeof v === "number" ? v : null
}
const plural = (v: number | null, one: string, many = `${one}s`) => `${fmtInt(v)} ${v === 1 ? one : many}`

function funnelRows(index: SnapshotIndex): Row[] {
  const p = index.snapshot.provenance
  const st = (name: string) => p.stages.find((s) => s.stage === name)
  const m = p.models ?? {}
  const facets = st("facets")
  const discover = st("discover")
  const classify = st("classify")
  const leftovers = st("leftovers")
  const hierarchy = st("hierarchy")
  const describe = st("describe")
  const gate = st("gate")
  const publish = st("publish")
  const rows: Row[] = [
    {
      key: "facets",
      value: n(facets, "facets"),
      unit: "private summaries",
      title: "Summarize each transcript privately",
      detail: [
        `goal, task, domain, language per conversation; ${plural(n(facets, "pii_rewritten"), "summary", "summaries")} rewritten after a PII score, ${fmtInt(n(facets, "pii_fallback"))} replaced`,
        `4 friction signals decided per conversation (observed / unclear / not): ${fmtInt(n(facets, "friction_observed"))} with friction`,
      ],
      models: [m.facets, m.friction],
    },
    {
      key: "discover",
      value: n(discover, "k"),
      unit: "k-means clusters",
      title: "Embed the summaries, then cluster",
      detail: [
        `${fmtInt(n(discover, "embedded"))} summaries embedded (never raw text); clustered on ${fmtInt(n(discover, "capped_subset"))} after a per-person cap and near-duplicate removal`,
        `clusters named by their goals and merged into ${plural(n(discover, "themes"), "theme")}`,
      ],
      models: [m.embeddings, m.naming],
    },
    {
      key: "classify",
      value: n(classify, "classified"),
      unit: "conversations classified",
      title: "Jev files every conversation into a theme",
      detail: [
        `a calibrated choice over ${fmtInt(n(classify, "themes"))} themes; below 0.65 confidence it goes to Other (${fmtInt(n(classify, "other"))} at first)`,
      ],
      models: [m.classification],
    },
    {
      key: "leftovers",
      value: n(leftovers, "themes"),
      unit: "themes after re-discovery",
      title: "Re-discover what didn't fit",
      detail: [
        `${plural(n(leftovers, "rounds"), "round")} over Other: ${fmtInt(n(leftovers, "themes_added"))} themes added, ${fmtInt(n(leftovers, "themes_broadened"))} broadened; Other shrank to ${fmtInt(n(leftovers, "other"))}`,
      ],
      models: [m.consolidation],
    },
    {
      key: "hierarchy",
      value: n(hierarchy, "leaves"),
      unit: "workflows",
      title: `Build the hierarchy: ${plural(n(hierarchy, "categories"), "category", "categories")}`,
      detail: [
        `GLM proposes the categories, Jev re-files each workflow and flags disagreement (${fmtInt(n(hierarchy, "jev_disagreements"))} resolved)`,
        `${fmtInt(n(describe, "needs"))} needs and ${fmtInt(n(describe, "problems"))} problems written, each tied to evidence`,
      ],
      models: [m.hierarchy, m.descriptions],
    },
    {
      key: "gate",
      value: n(gate, "texts_checked"),
      unit: "published texts checked",
      title: "Privacy gate on every published string",
      detail: [
        `patterns, canary tokens, source-phrase overlap, a GLM audit and Jev identifiability: ${fmtInt(n(gate, "passed_first"))} passed first time, ${fmtInt(n(gate, "rewritten"))} rewritten, ${fmtInt(n(gate, "dropped"))} dropped`,
        `publish: counts recomputed by code, ${fmtInt(n(publish, "fixture_token_hits"))} planted-token hits`,
      ],
      models: [m.privacy_audit, m.identifiability],
    },
  ]
  return rows
}

function secondsBetween(s?: ProvenanceStage) {
  if (!s) return null
  const ms = Date.parse(s.finished_at) - Date.parse(s.started_at)
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null
}

function Funnel({ index }: { index: SnapshotIndex }) {
  const p = index.snapshot.provenance
  const rows = funnelRows(index)
  const facets = p.stages.find((s) => s.stage === "facets")
  const intake = p.stages.find((s) => s.stage === "intake")
  const built = n(facets, "conversations")
  const minutes = p.build_seconds ? Math.round(p.build_seconds / 60) : null
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-6 py-8 lg:py-10">
        <p className="text-[12.5px] font-medium tracking-wide text-brand uppercase">1 · Organize · all conversations</p>
        <h2 className="mt-2 max-w-[760px] text-[clamp(24px,3vw,34px)] leading-tight font-semibold tracking-[-0.02em] text-balance">
          The same steps, for all {fmtInt(built)} conversations, from transcripts up to a hierarchy.
        </h2>
        <p className="mt-2 max-w-[760px] text-[14px] text-muted-foreground">
          Recorded by the pipeline that built this snapshot{minutes ? ` (${minutes} min end to end)` : ""}. Models only label and decide; code computes every count.
          {intake ? ` A later live intake filed ${fmtInt(n(intake, "conversations"))} more conversations the same way.` : ""}
        </p>

        <ol className="relative mt-8 grid gap-2.5">
          <span aria-hidden className="absolute top-4 bottom-4 left-[88px] hidden w-px bg-border sm:block" />
          {rows.map((r, i) => {
            const stage = p.stages.find((s) => s.stage === r.key)
            const secs = secondsBetween(stage)
            return (
              <li
                key={r.key}
                style={{ animationDelay: `${i * 90}ms` }}
                className="relative grid animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-500 motion-reduce:animate-none sm:grid-cols-[76px_24px_minmax(0,1fr)] sm:items-start sm:gap-x-0"
              >
                <div className="text-right font-mono text-[22px] leading-none font-semibold tabular-nums sm:pt-3">{fmtInt(r.value)}</div>
                <div className="hidden justify-center pt-4 sm:flex">
                  <span className="relative z-10 size-2.5 rounded-full border-2 border-background bg-foreground" />
                </div>
                <div className="rounded-xl border bg-card px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[14px] font-semibold">{r.title}</span>
                    <span className="text-[12px] text-muted-foreground">{r.unit}</span>
                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      {[...new Set(r.models.filter(Boolean).map(modelLabel))].map((label) => (
                        <ModelChip key={label} label={label} />
                      ))}
                      {secs != null && secs >= 1 ? <span className="font-mono text-[11px] text-subtle tabular-nums">{fmtSecs(secs)}</span> : null}
                    </span>
                  </div>
                  <ul className="mt-1 grid gap-0.5 text-[12.5px] leading-snug text-muted-foreground">
                    {r.detail.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const fmtSecs = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`)

// ---------------------------------------------------------------- the map

function MapBeat({ index }: { index: SnapshotIndex }) {
  const [lens, setLens] = useState<Lens>("usage")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]">
      <section aria-label="Usage map" className="relative min-h-[420px] overflow-hidden rounded-xl border bg-card">
        <UsageMap
          index={index}
          lens={lens}
          highlight={NO_HIGHLIGHT}
          selectedId={selectedId}
          focusId={focusId}
          peekId={null}
          onSelectLeaf={setSelectedId}
          onFocusCategory={setFocusId}
          onLens={setLens}
        />
      </section>
      <aside aria-label="Details" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <Lead
          eyebrow="1 · Organize · the map"
          title="The result: a map of what people actually do with the assistant."
          points={[
            "Each circle is a workflow, sized by conversations; the ring around it is its category",
            "Switch the lens to Friction to recolour by where conversations go wrong",
            "Click a workflow for its needs and problems, each tied to evidence and checked for privacy",
          ]}
        />
        <div className="rounded-xl border bg-card px-5 py-4">
        <DetailPanel
          index={index}
          selectedId={selectedId}
          focusId={focusId}
          onSelectLeaf={setSelectedId}
          onFocusCategory={setFocusId}
          onShowFinding={(catId, leafId) => {
            setFocusId(catId)
            if (leafId) setSelectedId(leafId)
          }}
          onAsk={askFromStory}
        />
        </div>
      </aside>
    </div>
  )
}
