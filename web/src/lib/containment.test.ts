import { describe, expect, it } from "vitest"
import { destructiveView } from "./containment"

const d = {
  command: "rm -rf --no-preserve-root /",
  exit_code: 1,
  refused: 11089,
  container_removed: true,
  root_read_only: true,
  binaries_intact: true,
  next_run_clean: true,
  contained: true,
}

describe("destructiveView", () => {
  it("uses the final object when present", () => {
    const v = destructiveView(d, "done")
    expect(v.headline).toBe("absorbed")
    expect(v.exitCode).toBe(1)
    expect(v.refused).toBe(11089)
    expect(v.checks.map((c) => c.state)).toEqual([true, true, true])
    expect(v.checks[0].note).toBe("reported from inside the sandbox")
  })

  it("reports a failure honestly and treats missing inside reports as not reported", () => {
    const bad = destructiveView({ ...d, binaries_intact: false, contained: false }, "done")
    expect(bad.headline).toBe("not_contained")
    expect(bad.checks[0].state).toBe(false)
    expect(destructiveView({ ...d, root_read_only: null }, "done").checks[0].state).toBeNull()
  })

  it("follows the named stage while the run is live", () => {
    expect(destructiveView(null, "running").headline).toBe("running")
    expect(destructiveView(null, "running").checks.every((c) => c.state === "wait")).toBe(true)
    expect(destructiveView(undefined, undefined).headline).toBe("pending")
    expect(destructiveView(null, "failed").headline).toBe("not_contained")
    expect(destructiveView(null, "pending").command).toBe("rm -rf --no-preserve-root /")
  })
})
