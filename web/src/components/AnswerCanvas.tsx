import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react"
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react"
import { ArrowLeft, ArrowUpRight, LoaderCircle, Sparkles } from "lucide-react"
import { canvasCatalog } from "@/lib/canvas"
import { useCanvas } from "@/hooks/useCanvas"
import type { SnapshotIndex } from "@/lib/snapshot"
import type { QuestionResult, Run, Node } from "@/lib/types"
import { fmtInt, fmtPct } from "@/lib/format"
import { Button } from "./ui/button"

type Content = { result: QuestionResult; index: SnapshotIndex; ranking: ReactNode; open: (id: string) => void }
const ContentContext = createContext<Content | null>(null)
function useContent() {
  const content = useContext(ContentContext)
  if (!content) throw new Error("Answer components require checked content.")
  return content
}
function useNodes() {
  const { result, index } = useContent()
  return result.rows.flatMap((row) => { const node = index.byId.get(row.id); return node ? [{ row, node }] : [] })
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="space-y-3">
    <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
    {note ? <p className="text-[13px] leading-relaxed text-muted-foreground">{note}</p> : null}
    {children}
  </section>
}

function WorkflowCards() {
  const { result, open } = useContent()
  const nodes = useNodes()
  return <Section title="What people are doing" note="Published workflow descriptions, with the counts from this answer.">
    <div className="grid gap-2 sm:grid-cols-2">
      {nodes.map(({ row, node }) => <button key={node.id} onClick={() => open(node.id)} className="rounded-xl border bg-background p-3 text-left transition-colors hover:border-brand/50 focus-visible:outline-2 focus-visible:outline-brand">
        <span className="flex items-start justify-between gap-2 text-[14px] font-medium">{node.title}<ArrowUpRight aria-hidden className="mt-0.5 size-3.5 shrink-0" /></span>
        <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">{node.description}</span>
        <span className="mt-3 block text-[13px] font-medium tabular-nums">{fmtInt(row.count)} of {fmtInt(row.base)} {result.plan.measure === "people" ? "people" : "conversations"} · {fmtPct(row.share)}</span>
      </button>)}
    </div>
  </Section>
}

function FrictionPlot() {
  const { index, open } = useContent()
  const nodes = useNodes()
  const max = Math.max(1, ...nodes.map(({ node }) => node.conversations))
  return <Section title="Where volume meets friction" note="Each point is a workflow in this answer. Position uses all published conversations in that workflow, independent of the answer’s filter.">
    <svg viewBox="0 0 440 230" className="w-full overflow-visible" aria-label="Workflow conversation volume versus observed friction rate">
      <text x="44" y="12" fontSize="12" fill="currentColor">Observed friction rate ↑</text>
      {[0, 0.5, 1].map((value) => <g key={value}>
        <line x1="44" x2="420" y1={190 - value * 165} y2={190 - value * 165} stroke="currentColor" opacity="0.12" />
        <text x="36" y={194 - value * 165} textAnchor="end" fill="currentColor" fontSize="12">{fmtPct(value)}</text>
      </g>)}
      <text x="44" y="210" fontSize="12" fill="currentColor">0</text>
      <text x="420" y="210" textAnchor="end" fontSize="12" fill="currentColor">{fmtInt(max)}</text>
      <text x="230" y="228" textAnchor="middle" fontSize="12" fill="currentColor">Conversation volume →</text>
      {nodes.map(({ node }, i) => node.friction.share === null ? null : <g key={node.id}>
        <circle cx={50 + node.conversations / max * 360} cy={190 - node.friction.share! * 165} r="10"
          fill={index.paletteOf(node.id).dot} stroke="var(--background)" strokeWidth="2"
          tabIndex={0} role="button" className="cursor-pointer focus:outline-2 focus:outline-brand"
          aria-label={`${node.title}: ${fmtInt(node.conversations)} conversations, ${fmtPct(node.friction.share)} observed friction. Open workflow.`}
          onClick={() => open(node.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(node.id) } }}>
          <title>{node.title}: {fmtPct(node.friction.share)} friction</title>
        </circle>
        <text pointerEvents="none" x={50 + node.conversations / max * 360} y={194 - node.friction.share! * 165} textAnchor="middle" fill="var(--background)" fontSize="10">{i + 1}</text>
      </g>)}
    </svg>
    <ol className="grid gap-1 text-[13px]">
      {nodes.map(({ node }, i) => <li key={node.id}><button onClick={() => open(node.id)} className="flex w-full justify-between gap-3 rounded px-1 py-1 text-left hover:bg-muted"><span>{i + 1}. {node.title}</span><span className="shrink-0 tabular-nums">{fmtPct(node.friction.share)}</span></button></li>)}
    </ol>
    <p className="text-[12px] leading-relaxed text-muted-foreground">Friction means an observed signal, not measured emotional intensity. A high rate does not establish the cause.</p>
  </Section>
}

const SIGNAL_LABELS = { correction: "Corrections", repeat_request: "Asked again", assistant_limit: "Assistant limits", complaint: "Complaints" } as const
function SignalBreakdown() {
  const nodes = useNodes()
  return <Section title="How friction shows up" note="Published conversation counts for each workflow. One conversation can have several signals; do not add these counts together.">
    <div className="space-y-4">{nodes.slice(0, 5).map(({ node }) => <div key={node.id}>
      <p className="mb-2 text-[14px] font-medium">{node.title}</p>
      <div className="space-y-2">{Object.entries(SIGNAL_LABELS).map(([key, label]) => {
        const count = node.friction.signals[key as keyof typeof SIGNAL_LABELS]
        return <div key={key} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-[12px]">
          <span>{label}</span><span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-brand/60" style={{ width: `${node.conversations ? count / node.conversations * 100 : 0}%` }} /></span>
          <span className="tabular-nums">{fmtInt(count)} / {fmtInt(node.conversations)}</span>
        </div>
      })}</div>
      {node.friction.unclear > 0 ? <p className="mt-2 text-[12px] text-muted-foreground">{fmtInt(node.friction.unclear)} conversations have unclear friction.</p> : null}
    </div>)}</div>
    {nodes.length > 5 ? <p className="text-[12px] text-muted-foreground">Showing the first five workflows in this answer.</p> : null}
  </Section>
}

function NeedText({ node }: { node: Node }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    <div><p className="mb-2 text-[12px] font-medium text-brand">What people need</p><ul className="space-y-2 text-[13px] leading-relaxed">{node.needs?.slice(0, 3).map((need) => <li key={need.id}>{need.text}</li>)}</ul>{!node.needs?.length ? <p className="text-[13px] text-muted-foreground">No published needs.</p> : null}</div>
    <div><p className="mb-2 text-[12px] font-medium text-muted-foreground">Recurring problems</p><ul className="space-y-2 text-[13px] leading-relaxed">{node.problems?.slice(0, 3).map((problem) => <li key={problem.id}>{problem.text}<span className="mt-1 block text-[11px] text-muted-foreground">{problem.support === "common" ? "Common pattern" : "Observed pattern"}</span></li>)}</ul>{!node.problems?.length ? <p className="text-[13px] text-muted-foreground">No published problems.</p> : null}</div>
  </div>
}
function NeedsBoard() {
  const { open, index } = useContent()
  const nodes = useNodes().flatMap(({ node }) => node.level === 1 ? index.leavesOf(node.id) : [node])
    .filter((node) => node.needs?.length || node.problems?.length)
  return <Section title="Needs and possible gaps" note="Published patterns from workflows within this answer’s groups. These do not prove a missing capability, a cause, or a pairing between a specific need and problem.">
    {nodes.slice(0, 3).map((node) => <div key={node.id} className="rounded-xl border bg-background p-3">
      <button onClick={() => open(node.id)} className="mb-3 flex items-center gap-1 text-left text-[14px] font-medium hover:underline">{node.title}<ArrowUpRight aria-hidden className="size-3.5" /></button>
      <NeedText node={node} />
    </div>)}
    {!nodes.length ? <p className="text-[13px] text-muted-foreground">No needs or problems are published for these groups. Open a specific workflow to explore further.</p> : null}
    {nodes.length > 3 ? <p className="text-[12px] text-muted-foreground">Showing the first three workflows with published needs or problems, up to three of each per workflow.</p> : null}
  </Section>
}

const { registry } = defineRegistry(canvasCatalog, { components: {
  AnswerLayout: ({ children }) => <div className="space-y-6">{children}</div>,
  Ranking: () => useContent().ranking,
  WorkflowCards, FrictionPlot, SignalBreakdown, NeedsBoard,
} })

export function AnswerCanvas({ run, result, index, ranking, open }: Content & { run: Run }) {
  const { current, busy, notice, reshape, canGoBack, back } = useCanvas(run.run_id, run.snapshot_id)
  const [instruction, setInstruction] = useState("")
  const submit = (e: FormEvent) => { e.preventDefault(); if (instruction.trim() && !busy) void reshape(instruction.trim()) }
  return <ContentContext value={{ result, index, ranking, open }}>
    <div className="space-y-4 rounded-xl border bg-muted/15 p-3 sm:p-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium"><Sparkles aria-hidden className="size-4 text-brand" />Loggy’s answer canvas</span>
        <span role="status" className="flex items-center gap-1 text-[12px] text-muted-foreground">
          {busy ? <><LoaderCircle aria-hidden className="size-3 animate-spin" />Choosing a useful view…</> : current?.status === "mock" ? "Demo layout · no Jev call" : current?.status === "composed" ? "View composed by Jev" : "Standard view"}
        </span>
      </div>
      {current ? <JSONUIProvider registry={registry}><Renderer spec={current.spec} registry={registry} /></JSONUIProvider> : ranking}
      {current?.status === "fallback" ? <p role="status" className="text-[13px] text-muted-foreground">Jev is unavailable. Showing the checked answer in a standard view.</p> : null}
      {notice ? <p role="status" className="text-[13px] leading-relaxed text-muted-foreground">{notice}</p> : null}
      <div className="space-y-3 border-t pt-3">
        <div className="flex flex-wrap gap-1.5">
          {canGoBack ? <Button variant="outline" size="xs" disabled={busy} onClick={back}><ArrowLeft />Previous view</Button> : null}
          {[["Show cards", "Replace the main view with workflow cards"], ["Compare friction", "Show the friction plot and signal breakdown"], ["Explore needs", "Show needs and recurring problems first"], ["Just the numbers", "Show only ranked bars"]].map(([label, prompt]) => <Button key={label} variant="outline" size="xs" disabled={busy} onClick={() => void reshape(prompt)}>{label}</Button>)}
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <label className="sr-only" htmlFor={`canvas-${run.run_id}`}>Change this view</label>
          <input id={`canvas-${run.run_id}`} value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={200} disabled={busy} placeholder="Change this view: put the signals first…" className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-60" />
          <Button type="submit" size="sm" disabled={busy || !instruction.trim()}>Update</Button>
        </form>
        <p className="text-[12px] leading-relaxed text-muted-foreground">Changes the presentation of this answer. Ask a new question for a new topic or measure. Counts remain tied to the checked result; supporting patterns come from the published snapshot.</p>
      </div>
    </div>
  </ContentContext>
}
