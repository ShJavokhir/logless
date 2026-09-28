// Renders a validated §8b plan in words, e.g.
// "Distinct people · with repeated requests · within Build software · by workflow · top 5 by count"
import type { Plan, PlanSignal } from "./types"

const GROUP_WORDS: Record<Plan["group_by"], { by: string; all: string; one: string }> = {
  leaf: { by: "by workflow", all: "across all workflows", one: "workflow" },
  category: { by: "by category", all: "across all categories", one: "category" },
  subtheme: { by: "by sub-theme", all: "across all sub-themes", one: "sub-theme" },
}

const SIGNAL_WORDS: Record<PlanSignal, string> = {
  any_friction: "with any friction",
  correction: "with corrections",
  repeat_request: "with repeated requests",
  assistant_limit: "hitting assistant limits",
  complaint: "with complaints",
}

export function planToPhrases(plan: Plan, titleOf: (id: string) => string | undefined): string[] {
  const phrases: string[] = [plan.measure === "people" ? "Distinct people" : "Conversations"]
  if (plan.signal) phrases.push(SIGNAL_WORDS[plan.signal] ?? plan.signal)
  const words = GROUP_WORDS[plan.group_by] ?? GROUP_WORDS.leaf
  if (plan.scope_category_id) phrases.push(`within ${titleOf(plan.scope_category_id) ?? "one category"}`)
  else if (plan.scope_leaf_id) phrases.push(`within ${titleOf(plan.scope_leaf_id) ?? "one workflow"}`)
  else phrases.push(words.all)
  phrases.push(words.by)
  phrases.push(`top ${plan.limit} by ${plan.rank_by === "share" ? "share" : "count"}`)
  return phrases
}

export function planToWords(plan: Plan, titleOf: (id: string) => string | undefined): string {
  return planToPhrases(plan, titleOf).join(" · ")
}

/** Footnote explaining what "share" means for this plan. */
export function planShareNote(plan: Plan): string {
  const unit = plan.measure === "people" ? "distinct people" : "conversations"
  const group = (GROUP_WORDS[plan.group_by] ?? GROUP_WORDS.leaf).one
  return plan.signal
    ? `Share = ${unit} ${SIGNAL_WORDS[plan.signal] ?? plan.signal} ÷ all ${unit} in that ${group}.`
    : `Share = count ÷ all ${unit} in that ${group}.`
}
