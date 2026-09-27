import { describe, expect, it } from "vitest"
import type { Attempt, GateCheck, Run } from "./types"
import { crossChecks, isTwoProgram, programGateTally, programTracks, repairs, splitProgramPrefix } from "./programs"

const chk = (name: string, passed = true): GateCheck => ({ name, passed, detail: "" })
const att = (program: "A" | "B" | undefined, attempt: 1 | 2, passed: boolean, reason: string | null = null): Attempt => ({
  attempt,
  program,
  code: `# ${program}${attempt}`,
  code_sha256: `${program ?? "x"}${attempt}`.padEnd(64, "0"),
  receipt: null,
  verdict: { passed, checks: [chk("Schema matches exactly", passed), chk("Plan echoed exactly")] },
  repair_reason: reason,
})

describe("programTracks / repairs", () => {
  const run = { attempts_log: [att("A", 1, false, "Gate check failed: Shares equal count ÷ base within 1e-4"), att("B", 1, true), att("A", 2, true)] } as Pick<Run, "attempts_log">

  it("groups attempts per program in A, B order", () => {
    const t = programTracks(run)
    expect(t.map((x) => x.program)).toEqual(["A", "B"])
    expect(t[0].attempts).toHaveLength(2)
    expect(t[0].latest.attempt).toBe(2)
    expect(t[0].repaired).toBe(true)
    expect(t[1].repaired).toBe(false)
    expect(isTwoProgram(run)).toBe(true)
  })

  it("lists the failed version that was repaired, with its fixed-vocabulary reason", () => {
    expect(repairs(run)).toEqual([{ program: "A", failed: run.attempts_log![0], reason: "Gate check failed: Shares equal count ÷ base within 1e-4" }])
  })

  it("tallies the latest per-program checks", () => {
    expect(programGateTally(run)).toEqual({ passed: 4, total: 4 })
  })

  it("treats legacy single-program logs as program A", () => {
    const legacy = { attempts_log: [att(undefined, 1, true)] }
    expect(programTracks(legacy).map((t) => t.program)).toEqual(["A"])
    expect(isTwoProgram(legacy)).toBe(false)
    expect(programGateTally({ attempts_log: [] })).toBeNull()
  })
})

describe("crossChecks", () => {
  it("separates snapshot consistency and agreement from per-program checks", () => {
    const run = {
      attempts_log: [att("A", 1, true), att("B", 1, true)],
      verdict: {
        passed: true,
        checks: [
          chk("A · Schema matches exactly"),
          chk("B: Plan echoed exactly"),
          chk("Schema matches exactly"),
          chk("Consistent with the published map: base = published conversations"),
          chk("Two independent programs agree"),
        ],
      },
    } as Pick<Run, "verdict" | "attempts_log">
    const x = crossChecks(run)
    expect(x.agreement?.name).toBe("Two independent programs agree")
    expect(x.consistency.map((c) => c.name)).toEqual(["Consistent with the published map: base = published conversations"])
    expect(x.other).toEqual([])
  })

  it("parses program prefixes", () => {
    expect(splitProgramPrefix("Program B: Strict JSON parse")).toEqual({ program: "B", name: "Strict JSON parse" })
    expect(splitProgramPrefix("A · Size within 1 MiB")).toEqual({ program: "A", name: "Size within 1 MiB" })
    expect(splitProgramPrefix("Accurate total")).toEqual({ program: null, name: "Accurate total" })
  })
})
