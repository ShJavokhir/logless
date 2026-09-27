// Containment check (§6): the destructive-command card, derived from the final
// `containment.destructive` object, or from the named stage while running.
import type { DestructiveResult, StageStatus } from "./types"

export type CheckState = boolean | "wait" | "pending" | null // null = not reported

export type DestructiveView = {
  headline: "absorbed" | "not_contained" | "running" | "pending"
  command: string
  exitCode: number | null
  refused: number | null
  checks: { key: "readonly" | "removed" | "clean"; label: string; note?: string; state: CheckState }[]
}

export const DESTRUCTIVE_COMMAND = "rm -rf --no-preserve-root /"

export function destructiveView(d: DestructiveResult | null | undefined, stage: StageStatus | undefined): DestructiveView {
  const live: CheckState = stage === "done" ? true : stage === "failed" ? false : stage === "running" ? "wait" : "pending"
  const readOnly: CheckState = d
    ? d.root_read_only === null || d.binaries_intact === null
      ? null
      : d.root_read_only && d.binaries_intact
    : live
  return {
    headline: d ? (d.contained ? "absorbed" : "not_contained") : stage === "done" ? "absorbed" : stage === "failed" ? "not_contained" : stage === "running" ? "running" : "pending",
    command: d?.command ?? DESTRUCTIVE_COMMAND,
    exitCode: d?.exit_code ?? null,
    refused: d?.refused ?? null,
    checks: [
      { key: "readonly", label: "Read-only filesystem · nothing deleted", note: "reported from inside the sandbox", state: readOnly },
      { key: "removed", label: "Container destroyed", state: d ? d.container_removed : live },
      { key: "clean", label: "Next run clean — fresh container from the same pinned image", state: d ? d.next_run_clean : live },
    ],
  }
}
