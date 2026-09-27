// User-facing copy shared across components (kept out of component files so
// fast refresh stays component-only).
import type { Intent } from "./types"

export const QUESTION: Record<Intent, string> = {
  usage: "What are people doing?",
  friction: "What's not working?",
}

export const STORY_LABEL = "Fictional user story · Illustrates an aggregate pattern; not a real customer or additional evidence."

export const RUN_SUBTITLE =
  "GLM wrote this program without seeing any data; it ran in a gVisor sandbox with no network, and the gate checked every number against a trusted reference."

export const PEOPLE_HINT = "Distinct people, approximated from hashed IP addresses (shared or changing IPs make this approximate)"

export const AGGREGATE_ONLY_HINT = "No one can open a conversation here. Every number comes from code executed in a sandbox."

export const SANDBOX_UNAVAILABLE = "Live analysis unavailable; the saved snapshot is still browsable."

type Fixtures = { canary_conversations: number; injection_conversations?: number }

/** "40 canary + 10 injection-test conversations" (planted fixtures, counted in totals). */
export function fixturesPhrase(f: Fixtures | undefined): string | null {
  if (!f) return null
  const parts: string[] = []
  if (f.canary_conversations) parts.push(`${f.canary_conversations} canary`)
  if (f.injection_conversations) parts.push(`${f.injection_conversations} injection-test`)
  return parts.length ? `${parts.join(" + ")} conversations` : null
}

/** "50 test fixtures (40 canary + 10 injection)" for compact spots. */
export function fixturesShort(f: Fixtures | undefined): string | null {
  if (!f) return null
  const inj = f.injection_conversations ?? 0
  const total = f.canary_conversations + inj
  if (!total) return null
  return inj ? `${total} test fixtures (${f.canary_conversations} canary + ${inj} injection)` : `${total} canary test fixtures`
}

export function statsSourcePhrase(source: "sandbox" | "local-reference" | undefined): string | null {
  if (source === "sandbox") return "counts computed in the gVisor sandbox"
  if (source === "local-reference") return "counts from the local reference (sandbox unavailable at build)"
  return null
}
