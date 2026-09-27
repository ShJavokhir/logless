// User-facing copy shared across components (kept out of component files so
// fast refresh stays component-only).
import { fmtInt } from "./format"

export const STORY_LABEL = "Fictional user story · Illustrates an aggregate pattern; not a real customer or additional evidence."

export const RUN_SUBTITLE =
  "GLM wrote two independent programs for the validated plan without seeing any data. Each ran in its own gVisor sandbox with no network; the gate checked both outputs, cross-checked them against the published map where the plan allows, and required them to agree."

export const PEOPLE_HINT = "Distinct people, approximated from hashed IP addresses (shared or changing IPs make this approximate)"

export const ASK_LABEL = "Ask a question"

/** Example questions (§0: the former fixed reports are now just questions). */
export const EXAMPLE_QUESTIONS = [
  "What's not working?",
  "Which coding workflows have the most distinct people repeating requests?",
  "Where do people hit assistant limits most often, as a share?",
  "Which categories have the most complaints?",
] as const

export const ASK_SCOPE_NOTE =
  "Answers count conversations or distinct people, by workflow or category, optionally with one friction signal. Other or unclear is left out."

export const SANDBOX_UNAVAILABLE = "Live analysis unavailable; the saved snapshot is still browsable."

type Fixtures = { canary_conversations: number; injection_conversations?: number }

export function fixtureCount(f: Fixtures | undefined): number {
  return f ? f.canary_conversations + (f.injection_conversations ?? 0) : 0
}

/** "5,050 conversations (5,000 WildChat + 50 test fixtures)" */
export function conversationsPhrase(total: number, f: Fixtures | undefined): string {
  const fx = fixtureCount(f)
  return fx ? `${fmtInt(total)} conversations (${fmtInt(total - fx)} WildChat + ${fmtInt(fx)} test fixtures)` : `${fmtInt(total)} conversations`
}

/** Honest provenance for the header tooltip (§0: the map is pipeline-computed). */
export function provenanceHint(total: number, f: Fixtures | undefined): string {
  const fx = fixtureCount(f)
  const real = fmtInt(total - fx)
  return (
    `The map is computed by the logless pipeline on Vultr from ${real} real conversations${fx ? ` (+${fmtInt(fx)} test fixtures)` : ""}. ` +
    "Answers to questions are computed by agent-written code in a gVisor sandbox and checked by a gate. No one can open a conversation here."
  )
}

/** "50 test fixtures (40 canary + 10 injection)" for compact spots. */
export function fixturesShort(f: Fixtures | undefined): string | null {
  if (!f) return null
  const inj = f.injection_conversations ?? 0
  const total = f.canary_conversations + inj
  if (!total) return null
  return inj ? `${total} test fixtures (${f.canary_conversations} canary + ${inj} injection)` : `${total} canary test fixtures`
}

/** §11 product copy (the contract's sentence). */
export const INTAKE_COPY =
  "Live intake shows a generalized, PII-checked one-line summary for each new conversation as it is classified. Transcripts are never shown."
