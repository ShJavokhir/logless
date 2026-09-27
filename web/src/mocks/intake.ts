// Mock of §11 live intake. Generates a plausible Jev decision stream for a
// prepared batch (≈45 conv/s, p50 ≈240 ms, leaves weighted by current size,
// ≈20% friction, ≈8% Other below the cutoff) and, on publish, a real
// incremental snapshot: base metrics + the batch, recomputed per node.
import type {
  Decision,
  IntakeDelta,
  IntakeEvent,
  IntakeEventsResponse,
  IntakeStage,
  IntakeStatus,
  IntakeSummary,
  Metrics,
  Run,
  RunStage,
  Signal,
  Snapshot,
} from "@/lib/types"
import { SIGNALS } from "@/lib/types"

const BATCH = Number(import.meta.env?.VITE_MOCK_BATCH) || 300
const round4 = (x: number) => Math.round(x * 10000) / 10000
const iso = (ms: number) => new Date(ms).toISOString()

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(r: () => number, items: T[], weight: (t: T) => number): T {
  const total = items.reduce((a, t) => a + Math.max(0, weight(t)), 0)
  let x = r() * total
  for (const t of items) {
    x -= Math.max(0, weight(t))
    if (x <= 0) return t
  }
  return items[items.length - 1]
}

const EXTRA_LANGS = ["Spanish", "German", "Japanese", "Korean", "Arabic", "Turkish", "Italian"]
const OTHER_SUMMARIES = ["Send a greeting to check the assistant responds", "Ask a very short question with no clear goal", "Paste a fragment without any request"]

export function generateIntakeEvents(s: Snapshot, seed = 20260927, n = BATCH): IntakeEvent[] {
  const r = rng(seed)
  const leaves = s.clusters
  let t = 320
  const events: IntakeEvent[] = []
  for (let i = 0; i < n; i++) {
    // bursty arrivals from 24 concurrent Jev calls, ≈45/s on average
    t += r() < 0.18 ? 2 + r() * 6 : -Math.log(1 - r()) * 24
    const leaf = pick(r, leaves, (l) => l.conversations)
    const other = leaf.is_other || leaf.id === "cl_other"
    const friction = {} as Record<Signal, Decision>
    for (const sig of SIGNALS) {
      const pObs = leaf.conversations ? leaf.friction.signals[sig] / leaf.conversations : 0
      const x = r()
      friction[sig] = x < pObs * 0.85 ? "observed" : x < pObs * 0.85 + 0.06 ? "unclear" : "not_observed"
    }
    const langs = leaf.languages.length ? leaf.languages : [{ name: "English", conversations: 1 }]
    let language = pick(r, langs, (l) => l.conversations).name
    if (/^other/i.test(language)) language = EXTRA_LANGS[Math.floor(r() * EXTRA_LANGS.length)]
    const needs = leaf.needs ?? []
    const pool = other ? OTHER_SUMMARIES : needs.map((x) => x.text)
    const raw = pool.length ? pool[Math.floor(r() * pool.length)] : null
    const summary = raw && r() > 0.06 ? (raw.length > 90 ? `${raw.slice(0, 88).trimEnd()}…` : raw) : null
    events.push({
      seq: i + 1,
      t_ms: Math.round(t),
      leaf_id: other ? "cl_other" : leaf.id,
      p: round4(other ? 0.36 + r() * 0.28 : 0.66 + 0.33 * Math.sqrt(r())),
      friction,
      language,
      turns: 1 + Math.min(18, Math.floor(-Math.log(1 - r()) * 2.4)),
      summary,
    })
  }
  return events
}

const anyObserved = (e: IntakeEvent) => SIGNALS.some((sig) => e.friction[sig] === "observed")
const unclearOnly = (e: IntakeEvent) => !anyObserved(e) && SIGNALS.some((sig) => e.friction[sig] === "unclear")

/** Base snapshot + the batch, recomputed per node the way the pipeline would. */
export function applyIntake(base: Snapshot, events: IntakeEvent[], now = Date.now()): Snapshot {
  const s: Snapshot = structuredClone(base)
  const byLeaf = new Map<string, IntakeEvent[]>()
  for (const e of events) byLeaf.set(e.leaf_id, [...(byLeaf.get(e.leaf_id) ?? []), e])

  const bump = (node: Metrics, evs: IntakeEvent[], newPeople: number) => {
    node.conversations += evs.length
    node.users += newPeople
    node.friction.conversations += evs.filter(anyObserved).length
    node.friction.unclear += evs.filter(unclearOnly).length
    for (const sig of SIGNALS) node.friction.signals[sig] += evs.filter((e) => e.friction[sig] === "observed").length
    const langs = new Map(node.languages.map((l) => [l.name, l.conversations]))
    for (const e of evs) {
      const key = langs.has(e.language) ? e.language : "Other languages"
      langs.set(key, (langs.get(key) ?? 0) + 1)
    }
    node.languages = [...langs.entries()]
      .map(([name, conversations]) => ({ name, conversations }))
      .sort((a, b) => (/^other/i.test(a.name) ? 1 : /^other/i.test(b.name) ? -1 : b.conversations - a.conversations))
  }
  const peopleFor = (k: number) => Math.round(k * 0.93)

  const leafNew = new Map<string, number>()
  for (const leaf of s.clusters) {
    const evs = byLeaf.get(leaf.id) ?? []
    const people = peopleFor(evs.length)
    leafNew.set(leaf.id, people)
    if (evs.length) bump(leaf, evs, people)
  }
  for (const cat of s.categories) {
    const kids = s.clusters.filter((l) => l.parent_id === cat.id)
    const evs = kids.flatMap((k) => byLeaf.get(k.id) ?? [])
    if (evs.length) bump(cat, evs, Math.round(kids.reduce((a, k) => a + (leafNew.get(k.id) ?? 0), 0) * 0.97))
  }
  bump(s.totals, events, Math.round(peopleFor(events.length) * 0.96))
  const total = s.totals.conversations
  for (const n of [...s.categories, ...s.clusters, s.totals]) {
    n.share = round4(n.conversations / total)
    n.friction.share = n.conversations ? round4(n.friction.conversations / n.conversations) : null
  }
  s.dataset.conversations = total
  s.dataset.users = s.totals.users
  const d = new Date(now)
  const p2 = (x: number) => String(x).padStart(2, "0")
  s.snapshot_id = `snap_${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}_${Math.floor(Math.random() * 65536).toString(16).padStart(4, "0")}`
  s.created_at = iso(now)
  return s
}

export function intakeDeltas(before: Snapshot, after: Snapshot, top = 8): IntakeDelta[] {
  const prev = new Map([...before.categories, ...before.clusters].map((n) => [n.id, n]))
  return [...after.categories, ...after.clusters]
    .map((n) => {
      const b = prev.get(n.id)!
      return { id: n.id, conversations_before: b.conversations, conversations_after: n.conversations, friction_share_before: b.friction.share, friction_share_after: n.friction.share }
    })
    .filter((x) => x.conversations_after !== x.conversations_before)
    .sort(
      (a, b) =>
        Math.abs(b.conversations_after - b.conversations_before) - Math.abs(a.conversations_after - a.conversations_before) ||
        Math.abs((b.friction_share_after ?? 0) - (b.friction_share_before ?? 0)) - Math.abs((a.friction_share_after ?? 0) - (a.friction_share_before ?? 0)),
    )
    .slice(0, top)
}

// ---------------------------------------------------------------- engine

type IntakeRun = {
  id: string
  createdAt: number
  events: IntakeEvent[]
  base: Snapshot
  published: Snapshot | null
  stageEnds: Record<Exclude<IntakeStage, "done">, number> // ms after start
  summary: IntakeSummary | null
}

export function createIntakeMock(access: { get: () => Snapshot; set: (s: Snapshot) => void; presenter: () => boolean; newId: () => string }) {
  let base: Snapshot | null = null
  let consumed = false
  let current: IntakeRun | null = null

  const stageAt = (r: IntakeRun, t: number): IntakeStage => {
    for (const k of ["deciding", "filing", "gating", "publishing", "evaluating"] as const) if (t < r.stageEnds[k]) return k
    return "done"
  }

  /** Publishing happens inside the timeline; do it lazily when observed. */
  const advance = (r: IntakeRun, t: number) => {
    if (!r.published && t >= r.stageEnds.publishing) {
      r.published = applyIntake(r.base, r.events, r.createdAt + r.stageEnds.publishing)
      access.set(r.published)
      consumed = true
      r.summary = {
        batch_size: r.events.length,
        decided: r.events.length,
        other: r.events.filter((e) => e.leaf_id === "cl_other").length,
        published_snapshot_id: r.published.snapshot_id,
        base_snapshot_id: r.base.snapshot_id,
        deltas: intakeDeltas(r.base, r.published),
      }
    }
  }

  return {
    status(): IntakeStatus {
      const snap = access.get()
      return { ready: !consumed && !current, batch_size: BATCH, base_snapshot_id: base?.snapshot_id ?? snap.snapshot_id }
    },
    start(): { run_id: string } | { error: [number, string, string] } {
      if (!access.presenter()) return { error: [403, "presenter_required", "Presenter key required."] }
      if (current && stageAt(current, Date.now() - current.createdAt) !== "done") return { error: [409, "intake_in_flight", "An intake run is already in progress."] }
      if (consumed) return { error: [409, "intake_not_ready", "No prepared batch is ready."] }
      base = base ?? access.get()
      const events = generateIntakeEvents(base, Math.floor(Math.random() * 1e9))
      const last = events[events.length - 1].t_ms + 250
      current = {
        id: access.newId(),
        createdAt: Date.now(),
        events,
        base,
        published: null,
        stageEnds: { deciding: last, filing: last + 700, gating: last + 1900, publishing: last + 2700, evaluating: last + 4200 },
        summary: null,
      }
      return { run_id: current.id }
    },
    events(runId: string, after: number): IntakeEventsResponse | null {
      const r = current
      if (!r || r.id !== runId) return null
      const t = Date.now() - r.createdAt
      advance(r, t)
      const stage = stageAt(r, t)
      const decided = r.events.filter((e) => e.t_ms <= t)
      const secs = Math.max(0.001, Math.min(t, r.stageEnds.deciding) / 1000)
      return {
        run_id: r.id,
        state: stage === "done" ? "completed" : "running",
        stage,
        counters: {
          total: r.events.length,
          decided: decided.length,
          per_second: Math.round((decided.length / secs) * 10) / 10,
          p50_ms: 236 + Math.round(Math.sin(t / 900) * 6),
          decisions_per_conversation: 5,
        },
        events: decided.filter((e) => e.seq > after).slice(0, 200),
      }
    },
    run(runId: string): Run | null {
      const r = current
      if (!r || r.id !== runId) return null
      const t = Date.now() - r.createdAt
      advance(r, t)
      const stage = stageAt(r, t)
      const keys = ["deciding", "filing", "gating", "publishing", "evaluating"] as const
      let prev = 0
      const stages: RunStage[] = keys.map((k) => {
        const start = prev
        const end = r.stageEnds[k]
        prev = end
        const status = t >= end ? "done" : t >= start ? "running" : "pending"
        return { name: k, status, started_at: t >= start ? iso(r.createdAt + start) : null, finished_at: t >= end ? iso(r.createdAt + end) : null, detail: null }
      })
      const done = stage === "done"
      return {
        run_id: r.id, kind: "intake", intent: null, snapshot_id: (r.published ?? r.base).snapshot_id,
        state: done ? "completed" : "executing", created_at: iso(r.createdAt), updated_at: iso(Date.now()),
        stages, attempts: 0, code: null, receipt: null, verdict: null, result: null, explanation: null, containment: null,
        error: null, question: null, plan: null, attempts_log: [], intake: done ? r.summary : null,
      }
    },
    reset(): { ok: true } | { error: [number, string, string] } {
      if (!access.presenter()) return { error: [403, "presenter_required", "Presenter key required."] }
      if (base) access.set(base)
      consumed = false
      current = null
      return { ok: true }
    },
  }
}
