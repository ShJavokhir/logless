import type { Node as SnapshotNode, Prd } from "./types"

export const METRIC_NAMES: Record<string, string> = {
  conversations: "Conversations",
  people: "Distinct people",
  share_of_all: "Share of all conversations",
  friction_share: "Friction share",
  friction_conversations: "Conversations with friction",
  correction: "Correction",
  repeat_request: "Repeated request",
  assistant_limit: "Assistant limit",
  complaint: "Complaint",
}

/** The PRD as Markdown, with evidence ids resolved to the published need / problem text. */
export function prdMarkdown(prd: Prd, leaf: SnapshotNode): string {
  const evidence = [...(leaf.needs ?? []), ...(leaf.problems ?? [])]
  const cited = evidence.filter((e) => prd.citations.includes(e.id))
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n")
  const pr = prd.priority
  return [
    `# ${prd.title}`,
    "",
    `**Workflow:** ${leaf.title}  `,
    `**Priority:** ${pr.level ?? "Unranked"}${pr.rank ? ` (rank ${pr.rank} of ${pr.of})` : ""} — ${pr.basis}`,
    "",
    "## Problem",
    prd.problem,
    "",
    "## User stories",
    list(prd.user_stories),
    "",
    "## Requirements",
    list(prd.requirements),
    "",
    "## Success metrics",
    list(prd.success_metrics),
    "",
    "## Evidence (published, generalized)",
    list(cited.map((e) => `[${e.id}] ${e.text}`)),
    "",
    "## Baseline numbers (from verified published metrics)",
    list(prd.metrics_used.map((m) => `${METRIC_NAMES[m.name] ?? m.name}: ${m.value}`)),
    "",
    `_${prd.label} Snapshot ${prd.snapshot_id}, ${prd.model}, ${prd.generated_at}._`,
    "",
  ].join("\n")
}

