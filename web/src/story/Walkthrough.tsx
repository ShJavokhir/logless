import { Fragment, type ReactNode } from "react"
import { ArrowRight, Check, FlaskConical, X } from "lucide-react"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { Signal } from "@/lib/types"
import { SIGNALS } from "@/lib/types"
import { SIGNAL_LABEL } from "@/lib/colors"
import { modelLabel } from "@/lib/snapshot"
import { fmtInt } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ModelChip } from "./ModelChip"
import example from "./example.json"

type Example = typeof example
const FAKE_DETAILS = ["Dana Whitfield", "Brightwater Logistics"]

/** One synthetic conversation, recorded through the real pipeline functions (backend/scripts/story_example.py). */
export function Walkthrough({ index }: { index: SnapshotIndex }) {
  const ex: Example = example
  const s = ex.stages
  const pool = s.neighbours.pool
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-6 py-6 lg:py-8">
        <p className="text-[12.5px] font-medium tracking-wide text-brand uppercase">1 · Organize · one conversation</p>
        <h2 className="mt-2 max-w-[860px] text-[clamp(22px,2.6vw,30px)] leading-tight font-semibold tracking-[-0.02em] text-balance">
          Follow one conversation from raw transcript to its place in the hierarchy.
        </h2>

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,40fr)_minmax(0,60fr)]">
          <Transcript turns={ex.transcript} />

          <ol className="flex flex-col gap-2.5">
            <Stage n={1} delay={0} title="Private summary" models={[s.facets.model]} ms={s.facets.glm_ms}>
              <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] leading-snug">
                <dt className="text-muted-foreground">Goal</dt>
                <dd>{s.facets.user_goal}</dd>
                <dt className="text-muted-foreground">Task</dt>
                <dd>{s.facets.task}</dd>
                <dt className="text-muted-foreground">Domain</dt>
                <dd>
                  {s.facets.domain} · {s.facets.language}
                </dd>
              </dl>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Pass ok={!s.facets.fake_name_in_facet_text}>name dropped</Pass>
                <Pass ok={!s.facets.fake_company_in_facet_text}>company dropped</Pass>
                <Pass ok={s.facets.pii.before < s.facets.pii.threshold}>
                  PII score {s.facets.pii.before.toFixed(2)} &lt; {s.facets.pii.threshold.toFixed(2)} · {modelLabel(s.facets.pii.model)}
                </Pass>
              </div>
              <Note>From here on, only this summary is used. Above the PII threshold it would be rewritten, then replaced.</Note>
            </Stage>

            <Stage n={2} delay={1} title="Embedding" models={[s.embedding.model]} ms={s.embedding.ms}>
              <p className="font-mono text-[12px] leading-snug">
                [{s.embedding.first_values.map((v) => v.toFixed(4)).join(", ")}, … ]{" "}
                <span className="text-muted-foreground">{fmtInt(s.embedding.dims)} dims</span>
              </p>
              <Note>The summary is embedded, never the transcript. The build clusters these vectors with k-means.</Note>
            </Stage>

            <Stage n={3} delay={2} title={`Nearest ${s.neighbours.k} of ${fmtInt(pool)} summaries`} models={[]} ms={s.neighbours.ms}>
              <Neighbours by={s.neighbours.by_leaf} k={s.neighbours.k} index={index} chosen={s.jev.theme.chosen_leaf_id} />
              <Note>
                Similarity alone is ambiguous: the closest match is {s.neighbours.top_similarity.toFixed(2)}, and neighbours spread over{" "}
                {s.neighbours.by_leaf.length} workflows. So a calibrated classifier makes the call.
              </Note>
            </Stage>

            <Stage n={4} delay={3} title={`Jev decides · ${s.jev.questions} typed questions, one call`} models={[s.jev.model]} ms={s.jev.ms}>
              <div className="grid gap-1">
                {s.jev.theme.top.map((t) => (
                  <div key={t.name} className="grid grid-cols-[minmax(0,1fr)_120px_40px] items-center gap-2 text-[12.5px]">
                    <span className={cn("truncate", t.leaf_id === s.jev.theme.chosen_leaf_id ? "font-medium" : "text-muted-foreground")}>{t.name}</span>
                    <span className="relative h-1.5 rounded-full bg-faint">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${t.p * 100}%` }} />
                      <span className="absolute -top-1 -bottom-1 w-px bg-foreground/40" style={{ left: `${s.jev.cutoff * 100}%` }} title={`cutoff ${s.jev.cutoff}`} />
                    </span>
                    <span className="text-right font-mono text-[11.5px] tabular-nums">{t.p.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {SIGNALS.map((sig) => (
                  <FrictionChip key={sig} signal={sig} {...s.jev.friction[sig]} />
                ))}
              </div>
              <Note>Below {s.jev.cutoff} confidence a conversation goes to Other instead of a guess. Friction is tri-state: observed, unclear or not.</Note>
            </Stage>

            <Stage n={5} delay={4} title="Placed in the hierarchy" models={[]} ms={null}>
              <Placement index={index} place={s.placement} friction={s.jev.friction} />
            </Stage>
          </ol>
        </div>

        <p className="mt-5 flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
          <FlaskConical aria-hidden className="mt-px size-3.5 shrink-0" />
          {ex.note} Recorded {new Date(ex.recorded_at).toUTCString().replace(/:\d\d GMT/, " UTC")} against snapshot {ex.snapshot_id}. Real conversations are never
          shown.
        </p>
      </div>
    </div>
  )
}

function Stage({ n, delay, title, models, ms, children }: { n: number; delay: number; title: string; models: string[]; ms: number | null; children: ReactNode }) {
  return (
    <li
      style={{ animationDelay: `${150 + delay * 260}ms` }}
      className="grid animate-in grid-cols-[22px_minmax(0,1fr)] gap-x-3 fade-in-0 slide-in-from-right-2 fill-mode-both duration-500 motion-reduce:animate-none"
    >
      <span className="mt-3 grid size-5.5 place-items-center rounded-full bg-foreground font-mono text-[11px] text-background">{n}</span>
      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13.5px] font-semibold">{title}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {models.map((m) => (
              <ModelChip key={m} label={modelLabel(m)} />
            ))}
            {ms != null ? <span className="font-mono text-[11px] text-subtle tabular-nums">{ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`}</span> : null}
          </span>
        </div>
        {children}
      </div>
    </li>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">{children}</p>
}

function Pass({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 items-center gap-1 rounded-full border px-2 text-[11.5px]",
        ok ? "border-ok/25 bg-ok-soft text-ok" : "border-heat/30 bg-heat-soft text-heat",
      )}
    >
      {ok ? <Check aria-hidden className="size-3" /> : <X aria-hidden className="size-3" />}
      {children}
    </span>
  )
}

function FrictionChip({ signal, stored, p }: { signal: Signal; stored: string; p: number }) {
  const observed = stored === "observed"
  const unclear = stored === "unclear"
  return (
    <span
      className={cn(
        "inline-flex h-5.5 items-center gap-1.5 rounded-full border px-2 text-[11.5px]",
        observed ? "border-heat/30 bg-heat-soft text-heat" : unclear ? "border-warn/30 bg-warn-soft text-warn" : "text-muted-foreground",
      )}
    >
      {SIGNAL_LABEL[signal]}
      <span className="font-mono text-[10.5px] opacity-80">
        {observed ? "observed" : unclear ? "unclear" : "not observed"} · {p.toFixed(2)}
      </span>
    </span>
  )
}

function Neighbours({ by, k, index, chosen }: { by: Example["stages"]["neighbours"]["by_leaf"]; k: number; index: SnapshotIndex; chosen: string }) {
  const shown = by.slice(0, 4)
  const rest = by.slice(4).reduce((a, b) => a + b.count, 0)
  const color = (id: string) => index.paletteOf(id).leaf
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full border">
        {by.map((b) => (
          <span
            key={b.leaf_id}
            title={`${b.title}: ${b.count}`}
            className={cn("h-full border-r border-card last:border-r-0", b.leaf_id === chosen && "ring-2 ring-foreground ring-inset")}
            style={{ width: `${(b.count / k) * 100}%`, background: color(b.leaf_id) }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
        {shown.map((b) => (
          <span key={b.leaf_id} className={cn(b.leaf_id === chosen && "font-medium text-foreground")}>
            <span className="font-mono tabular-nums">{b.count}</span> {b.short_title ?? b.title}
          </span>
        ))}
        {rest ? (
          <span>
            <span className="font-mono tabular-nums">{rest}</span> in {by.length - shown.length} others
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Placement({ index, place, friction }: { index: SnapshotIndex; place: Example["stages"]["placement"]; friction: Example["stages"]["jev"]["friction"] }) {
  const observed = SIGNALS.filter((s) => friction[s].stored === "observed").map((s) => SIGNAL_LABEL[s].toLowerCase())
  // Prefer the live snapshot's counts when the leaf still exists; fall back to the recorded ones.
  const leaf = index.byId.get(place.leaf.id)
  const cat = place.category.id ? index.byId.get(place.category.id) : undefined
  const pal = index.paletteOf(place.leaf.id)
  const steps = [
    { label: "Category", title: cat?.title ?? place.category.title, sub: `${fmtInt(cat?.conversations ?? place.category.conversations)} conversations` },
    { label: "Workflow", title: leaf?.title ?? place.leaf.title, sub: `${fmtInt(leaf?.conversations ?? place.leaf.conversations)} conversations · ${fmtInt(leaf?.users ?? place.leaf.people)} people` },
    { label: "Conversation", title: "this one, counted once", sub: observed.length ? `friction: ${observed.join(", ")}` : "no friction observed" },
  ]
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {steps.map((st, i) => (
        <Fragment key={st.label}>
          {i > 0 ? <ArrowRight aria-hidden className="size-3.5 self-center text-subtle" /> : null}
          <div className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5" style={i < 2 ? { background: i === 0 ? pal.fill : pal.leaf, borderColor: pal.stroke } : undefined}>
            <div className="text-[10.5px] tracking-wide text-muted-foreground uppercase">{st.label}</div>
            <div className="text-[12.5px] leading-snug font-medium">{st.title}</div>
            <div className="text-[11px] text-muted-foreground">{st.sub}</div>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function Transcript({ turns }: { turns: { role: string; text: string }[] }) {
  return (
    <section aria-label="Synthetic transcript" className="flex max-h-[calc(100dvh-230px)] min-h-[320px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px]">
        <span className="font-semibold">Raw transcript</span>
        <span className="rounded-full border border-warn/30 bg-warn-soft px-2 py-px text-[11px] font-medium text-warn">synthetic · written for the demo</span>
        <span className="ml-auto text-muted-foreground">{turns.length} turns</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {turns.map((t, i) => (
          <div key={i} className={cn("max-w-[92%] rounded-xl px-3 py-2 text-[12px] leading-relaxed", t.role === "user" ? "self-end bg-foreground/[0.06]" : "self-start border")}>
            <div className="mb-0.5 text-[10.5px] tracking-wide text-muted-foreground uppercase">{t.role}</div>
            <TurnText text={t.text} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Prose with fenced code as compact monospace; the invented personal details are marked. */
function TurnText({ text }: { text: string }) {
  const parts = text.split(/```(?:\w+)?\n?/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1 max-h-28 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[10.5px] leading-snug">
            {p.trim()}
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {markDetails(p.trim())}
          </span>
        ),
      )}
    </>
  )
}

function markDetails(text: string): ReactNode {
  const re = new RegExp(`(${FAKE_DETAILS.join("|")})`, "g")
  return text.split(re).map((part, i) =>
    FAKE_DETAILS.includes(part) ? (
      <mark key={i} className="rounded-sm bg-heat-soft px-0.5 text-heat underline decoration-heat/50 decoration-dotted underline-offset-2" title="personal detail (invented)">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}
