import type { FrictionResult, FrictionRow, Snapshot, UsageResult, UsageRow } from "@/lib/types"

const round4 = (x: number) => Math.round(x * 10000) / 10000

export function usageResult(s: Snapshot): UsageResult {
  const total = s.totals.conversations
  const rows: UsageRow[] = s.clusters
    .map((c) => ({ cluster_id: c.id, conversations: c.conversations, users: c.users, share: total ? round4(c.conversations / total) : 0 }))
    .sort((a, b) => b.conversations - a.conversations || a.cluster_id.localeCompare(b.cluster_id))
  return { intent: "usage", snapshot_id: s.snapshot_id, total_conversations: total, rows }
}

export function frictionResult(s: Snapshot): FrictionResult {
  const rows: FrictionRow[] = s.clusters
    .map((c) => ({
      cluster_id: c.id,
      conversations: c.conversations,
      friction_conversations: c.friction.conversations,
      friction_share: c.conversations ? round4(c.friction.conversations / c.conversations) : 0,
      correction: c.friction.signals.correction,
      repeat_request: c.friction.signals.repeat_request,
      assistant_limit: c.friction.signals.assistant_limit,
      complaint: c.friction.signals.complaint,
      unclear: c.friction.unclear,
    }))
    .sort((a, b) => b.friction_conversations - a.friction_conversations || a.cluster_id.localeCompare(b.cluster_id))
  return { intent: "friction", snapshot_id: s.snapshot_id, total_conversations: s.totals.conversations, rows }
}

/** Explanation texts contain only placeholders — never literal numbers. */
export function usageExplanation(r: UsageResult): { text: string; metric_refs: string[] } {
  // index of the row with the fewest people per conversation among the top 5
  const top = r.rows.slice(0, 5)
  let fewIdx = 0
  top.forEach((row, i) => {
    if (row.users / row.conversations < top[fewIdx].users / top[fewIdx].conversations) fewIdx = i
  })
  const text =
    `The largest workflow is {{rows.0.cluster_id}}: {{rows.0.conversations}} conversations ` +
    `({{rows.0.share}} of {{total_conversations}}) from {{rows.0.users}} people. ` +
    `{{rows.${fewIdx}.cluster_id}} is nearly as large at {{rows.${fewIdx}.conversations}} conversations, ` +
    `but they come from only {{rows.${fewIdx}.users}} people — a handful of heavy users, not broad demand. ` +
    `{{rows.2.cluster_id}} follows with {{rows.2.conversations}}.`
  return {
    text,
    metric_refs: [
      "rows.0.cluster_id", "rows.0.conversations", "rows.0.share", "total_conversations", "rows.0.users",
      `rows.${fewIdx}.cluster_id`, `rows.${fewIdx}.conversations`, `rows.${fewIdx}.users`,
      "rows.2.cluster_id", "rows.2.conversations",
    ],
  }
}

export function frictionExplanation(r: FrictionResult): { text: string; metric_refs: string[] } {
  let hiIdx = 0
  r.rows.forEach((row, i) => {
    if (row.conversations >= 50 && row.friction_share > r.rows[hiIdx].friction_share) hiIdx = i
  })
  const text =
    `{{rows.0.cluster_id}} has the most conversations with friction: {{rows.0.friction_conversations}} of ` +
    `{{rows.0.conversations}} ({{rows.0.friction_share}}), led by corrections ({{rows.0.correction}}). ` +
    `The highest rate is in {{rows.${hiIdx}.cluster_id}} at {{rows.${hiIdx}.friction_share}}, ` +
    `where the assistant hit its limits in {{rows.${hiIdx}.assistant_limit}} conversations. ` +
    `{{rows.1.cluster_id}} is next by volume with {{rows.1.friction_conversations}}.`
  return {
    text,
    metric_refs: [
      "rows.0.cluster_id", "rows.0.friction_conversations", "rows.0.conversations", "rows.0.friction_share", "rows.0.correction",
      `rows.${hiIdx}.cluster_id`, `rows.${hiIdx}.friction_share`, `rows.${hiIdx}.assistant_limit`,
      "rows.1.cluster_id", "rows.1.friction_conversations",
    ],
  }
}
