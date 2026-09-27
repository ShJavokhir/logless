import type { GateCheck, Node, Plan, QuestionResult, QuestionRow, Signal, Snapshot } from "@/lib/types"

const round4 = (x: number) => Math.round(x * 10000) / 10000
const isOther = (n: Pick<Node, "id" | "is_other">) => !!n.is_other || n.id === "cl_other"

// ---------------------------------------------------------------- §8b questions (mock)

const SIGNAL_OF: [RegExp, Plan["signal"]][] = [
  [/repeat|again|re-?ask/i, "repeat_request"],
  [/limit|can'?t|cannot|refus|declin|unable/i, "assistant_limit"],
  [/complain|frustrat|angry|annoy/i, "complaint"],
  [/correct|wrong|mistake|fix(ed)? the answer/i, "correction"],
  [/friction|struggl|fail|problem|not working|isn'?t working|trouble|break/i, "any_friction"],
]

const UNSUPPORTED: [RegExp, string][] = [
  [/next (week|month|year)|over time|trend|growth|forecast|predict|per day|daily|weekly|monthly|when do/i, "This snapshot has no dates per conversation, so trends and forecasts over time can't be computed."],
  [/\b(age|gender|country|countries|location|city|where .* from|nationalit)/i, "People are only hashed IP addresses here, with no age, gender or location to group by."],
  [/\b(show|read|quote|give) me (the |a |an )?(conversation|chat|transcript|message)|exact (words|prompt)|verbatim/i, "Individual conversations are never available; only counts of conversations or people can be computed."],
  [/\b(why|how come|what causes|recommend|should we)/i, "That asks for a cause or a recommendation; this tool only counts conversations or people by workflow, category and friction signal."],
  [/revenue|price|cost|money we|churn|retention|satisfaction score|nps/i, "The snapshot has no revenue, retention or satisfaction data; it only counts conversations, people and friction signals."],
]

const stem = (w: string) => w.toLowerCase().replace(/(ing|ers|er|ed|es|s)$/u, "")
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4).map(stem)

const SCOPE_HINTS: [RegExp, RegExp][] = [
  [/cod|software|program|debug|develop|bug|script/i, /software|code|develop|program/i],
  [/learn|study|homework|academic|school|student|exam/i, /learn|study|homework|academic/i],
  [/fiction|story|creative|roleplay|role-play|writing stor/i, /fiction|creative|imaginative/i],
  [/quick|trivia|fact|answer.*question|information/i, /quick|answers|information|everyday/i],
  [/business|marketing|career|job|professional|promo/i, /business|professional|promotional|career/i],
  [/image|prompt|midjourney|picture/i, /image/i],
]

export type Interpretation = { plan: Plan } | { unsupported: string }

/** Mock stand-in for the GLM interpreter: closed-vocabulary plan or a short reason. */
export function interpretQuestion(q: string, s: Snapshot): Interpretation {
  const text = q.trim()
  for (const [re, reason] of UNSUPPORTED) if (re.test(text)) return { unsupported: reason }
  const measure: Plan["measure"] = /\b(people|persons|users|who|distinct)\b/i.test(text) ? "people" : "conversations"
  const signal = SIGNAL_OF.find(([re]) => re.test(text))?.[1] ?? null
  const group_by: Plan["group_by"] = /categor/i.test(text) ? "category" : "leaf"
  const rank_by: Plan["rank_by"] = /share|rate|proportion|percent|often|likel|fraction/i.test(text) ? "share" : "count"
  const limit = Math.max(1, Math.min(10, Number(/top\s+(\d{1,2})/i.exec(text)?.[1] ?? 5)))
  let scope: string | null = null
  if (group_by === "leaf") {
    const cats = s.categories.filter((c) => !isOther(c))
    for (const [qre, tre] of SCOPE_HINTS) {
      if (!qre.test(text)) continue
      const hit = cats.find((c) => tre.test(c.title) || tre.test(c.short_title ?? ""))
      if (hit) {
        scope = hit.id
        break
      }
    }
    if (!scope) {
      const qw = new Set(words(text))
      const scored = cats.map((c) => ({ c, n: words(c.title).filter((w) => qw.has(w)).length })).sort((a, b) => b.n - a.n)
      if (scored[0]?.n) scope = scored[0].c.id
    }
  }
  const countable = signal || measure === "people" || /how many|most|which|top|count|workflow|categor|where/i.test(text)
  if (!countable) return { unsupported: "That question doesn't map to counts of conversations or people by workflow, category or friction signal." }
  return { plan: { group_by, scope_category_id: scope, measure, signal, rank_by, limit } }
}

/**
 * Mock of the §8b reference computation from published aggregates. Conversation
 * counts are exact; for measure "people" with a signal filter the snapshot has
 * no per-person data, so the count is an illustrative estimate (count ≤ base).
 */
export function questionResult(s: Snapshot, plan: Plan): QuestionResult {
  const groups = (plan.group_by === "category" ? s.categories : s.clusters).filter(
    (n) => !isOther(n) && (!plan.scope_category_id || n.parent_id === plan.scope_category_id),
  )
  const sigCount = (n: Node): number =>
    plan.signal === null ? n.conversations : plan.signal === "any_friction" ? n.friction.conversations : n.friction.signals[plan.signal as Signal]
  const rowOf = (n: Node): QuestionRow => {
    const base = plan.measure === "people" ? n.users : n.conversations
    const convCount = sigCount(n)
    const count =
      plan.measure === "people"
        ? plan.signal === null
          ? n.users
          : Math.min(base, Math.round((convCount / Math.max(1, n.conversations)) * n.users * 1.08))
        : convCount
    return { id: n.id, count, base, share: base ? round4(count / base) : 0 }
  }
  const all = groups.map(rowOf)
  const key = (r: QuestionRow) => (plan.rank_by === "share" ? r.share : r.count)
  const rows = [...all].sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id)).slice(0, Math.min(plan.limit, all.length))
  const scopeNode = plan.scope_category_id ? s.categories.find((c) => c.id === plan.scope_category_id) : null
  const other = s.categories.find(isOther)
  const total_base =
    plan.measure === "people"
      ? scopeNode
        ? scopeNode.users
        : s.totals.users - (other?.users ?? 0)
      : all.reduce((a, r) => a + r.base, 0)
  const total_count = plan.measure === "people" ? Math.min(total_base, all.reduce((a, r) => a + r.count, 0)) : all.reduce((a, r) => a + r.count, 0)
  return { intent: "question", snapshot_id: s.snapshot_id, plan, rows, total_count, total_base }
}

export function questionExplanation(r: QuestionResult): { text: string; metric_refs: string[] } {
  if (!r.rows.length) return { text: "No workflow in this scope matched the plan.", metric_refs: [] }
  const text =
    r.plan.rank_by === "share"
      ? `{{rows.0.id}} has the highest share at {{rows.0.share}} ({{rows.0.count}} of {{rows.0.base}})` +
        (r.rows.length > 1 ? `, ahead of {{rows.1.id}} at {{rows.1.share}}. ` : ". ") +
        `Across the whole scope it is {{total_count}} of {{total_base}}.`
      : `{{rows.0.id}} leads with {{rows.0.count}} of {{rows.0.base}} ({{rows.0.share}})` +
        (r.rows.length > 1 ? `, followed by {{rows.1.id}} with {{rows.1.count}}. ` : ". ") +
        `Across the whole scope it is {{total_count}} of {{total_base}}.`
  const refs = [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1])
  return { text, metric_refs: [...new Set(refs)] }
}

const CONSISTENT = "Consistent with the published map"

/**
 * §0 snapshot-consistency checks, only where the plan makes them derivable from
 * published numbers (the pipeline's map vs the agent's programs).
 */
export function consistencyChecks(s: Snapshot, r: QuestionResult): GateCheck[] {
  const plan = r.plan
  const nodes = new Map([...s.categories, ...s.clusters].map((n) => [n.id, n]))
  const unit = plan.group_by === "category" ? "category" : "workflow"
  const every = (pred: (row: QuestionRow, n: Node) => boolean) => r.rows.every((row) => {
    const n = nodes.get(row.id)
    return !!n && pred(row, n)
  })
  const out: GateCheck[] = []
  if (plan.measure === "conversations") {
    out.push({ name: `${CONSISTENT} · bases = published ${unit} conversations`, passed: every((row, n) => row.base === n.conversations), detail: `${r.rows.length} rows checked` })
    if (plan.signal === null) {
      const scope = plan.scope_category_id ? nodes.get(plan.scope_category_id) : null
      const expected = scope ? scope.conversations : s.totals.conversations - (s.categories.find(isOther)?.conversations ?? 0)
      out.push({ name: `${CONSISTENT} · total base = published scope total (no Other)`, passed: r.total_base === expected, detail: "1 total checked" })
    } else if (plan.signal === "any_friction") {
      out.push({ name: `${CONSISTENT} · counts = published friction conversations`, passed: every((row, n) => row.count === n.friction.conversations), detail: `${r.rows.length} rows checked` })
    } else {
      const sig = plan.signal as Signal
      out.push({ name: `${CONSISTENT} · counts = published ${sig.replace("_", " ")} counts`, passed: every((row, n) => row.count === n.friction.signals[sig]), detail: `${r.rows.length} rows checked` })
    }
  } else if (plan.signal === null) {
    out.push({ name: `${CONSISTENT} · bases = published ${unit} people`, passed: every((row, n) => row.base === n.users), detail: `${r.rows.length} rows checked` })
  }
  return out
}
