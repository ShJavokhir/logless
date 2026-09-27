import { splitCitations } from "./citations"
import { fmtInt, fmtPct } from "./format"
import { SIGNAL_LABEL } from "./colors"
import type { Node as SnapshotNode, Prd, Snapshot } from "./types"
import { SIGNALS } from "./types"

/** Citation chips ([n1], [p2]) are for the page; the prompt lists the evidence once instead. */
export const stripCitations = (text: string) =>
  splitCitations(text)
    .flatMap((p) => (p.kind === "text" ? [p.text] : []))
    .join("")
    .replace(/\s+([.,;:])/g, "$1")
    .trim()

/**
 * A task brief for a coding agent or an engineering team, built only from the
 * PRD draft and the workflow's published aggregates (no model call, no new numbers).
 */
export function agentPrompt(prd: Prd, leaf: SnapshotNode, snapshot: Snapshot): string {
  const evidence = [...(leaf.needs ?? []), ...(leaf.problems ?? [])].filter((e) => prd.citations.includes(e.id))
  const signals = SIGNALS.filter((s) => leaf.friction.signals[s] > 0)
    .sort((a, b) => leaf.friction.signals[b] - leaf.friction.signals[a])
    .map((s) => `${SIGNAL_LABEL[s].toLowerCase()} ${fmtInt(leaf.friction.signals[s])}`)
  const list = (xs: string[]) => xs.map((x) => `- ${stripCitations(x)}`).join("\n")
  const pr = prd.priority

  return [
    `# ${prd.title}`,
    "",
    "You are improving our AI assistant. Below is one workflow our users rely on, what goes wrong in it, and what to build. Start by proposing a short plan; do not change behaviour outside this workflow.",
    "",
    "## Context",
    `Workflow: ${leaf.title}. ${leaf.description}`,
    `${fmtInt(leaf.conversations)} of ${fmtInt(snapshot.totals.conversations)} conversations (${fmtInt(leaf.users)} people). ` +
      `${fmtInt(leaf.friction.conversations)} (${fmtPct(leaf.friction.share)}) show friction${signals.length ? `: ${signals.join(", ")}` : ""}.`,
    `Priority: ${pr.level ?? "unranked"}${pr.rank ? `, rank ${pr.rank} of ${pr.of}` : ""}.`,
    "",
    "## Problem",
    stripCitations(prd.problem),
    "",
    "## User stories",
    list(prd.user_stories),
    "",
    "## Requirements",
    list(prd.requirements),
    "",
    "## Done when",
    list(prd.success_metrics),
    ...(evidence.length ? ["", "## Evidence from usage (generalized, privacy-checked)", evidence.map((e) => `- ${e.text}`).join("\n")] : []),
    "",
  ].join("\n")
}
