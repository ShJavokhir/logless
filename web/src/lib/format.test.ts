import { describe, expect, it } from "vitest"
import { durationMs, fmtBytes, fmtDateRange, fmtInt, fmtPct, fmtShareOf, ratio } from "./format"

describe("format", () => {
  it("formats integers with thousands separators", () => {
    expect(fmtInt(5050)).toBe("5,050")
    expect(fmtInt(0)).toBe("0")
    expect(fmtInt(1234567.4)).toBe("1,234,567")
    expect(fmtInt(null)).toBe("unavailable")
    expect(fmtInt(Number.NaN)).toBe("unavailable")
  })

  it("formats shares as percentages with one decimal", () => {
    expect(fmtPct(0.1823)).toBe("18.2%")
    expect(fmtPct(0)).toBe("0.0%")
    expect(fmtPct(1)).toBe("100.0%")
    expect(fmtPct(null)).toBe("unavailable")
    expect(fmtPct(undefined)).toBe("unavailable")
  })

  it("renders share-of with the denominator, and null denominators as unavailable", () => {
    expect(fmtShareOf(148, 812)).toBe("18.2% · 148 of 812")
    expect(fmtShareOf(0, 1200)).toBe("0.0% · 0 of 1,200")
    expect(fmtShareOf(3, 0)).toBe("unavailable")
    expect(fmtShareOf(3, null)).toBe("unavailable")
    expect(ratio(1, 0)).toBeNull()
  })

  it("formats date ranges without timezone drift", () => {
    expect(fmtDateRange("2023-04-09", "2023-05-04")).toBe("Apr 9 – May 4, 2023")
    expect(fmtDateRange("2022-12-30", "2023-01-02")).toBe("Dec 30, 2022 – Jan 2, 2023")
  })

  it("computes durations and bytes", () => {
    expect(durationMs("2026-09-27T03:00:00.000Z", "2026-09-27T03:00:02.014Z")).toBe(2014)
    expect(durationMs(null, "2026-09-27T03:00:00Z")).toBeNull()
    expect(fmtBytes(512)).toBe("512 B")
    expect(fmtBytes(3174)).toBe("3.1 KiB")
  })
})
