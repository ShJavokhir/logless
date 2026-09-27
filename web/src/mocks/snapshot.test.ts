import { describe, expect, it } from "vitest"
import type { Node, Snapshot } from "@/lib/types"
import { SIGNALS } from "@/lib/types"
import snapshotJson from "./snapshot.json"
import { frictionResult, usageResult } from "./results"
import { mockStory } from "./stories"

const s = snapshotJson as unknown as Snapshot

function frictionOk(n: Pick<Node, "friction" | "conversations">) {
  const sig = SIGNALS.map((k) => n.friction.signals[k])
  expect(Math.max(...sig)).toBeLessThanOrEqual(n.friction.conversations)
  expect(n.friction.conversations).toBeLessThanOrEqual(sig.reduce((a, b) => a + b, 0))
  expect(n.friction.conversations).toBeLessThanOrEqual(n.conversations)
  expect(n.friction.share).toBeCloseTo(n.friction.conversations / n.conversations, 4)
}

describe("mock snapshot invariants (CONTRACTS §5)", () => {
  it("has 4–8 categories and 15–35 leaves including cl_other", () => {
    expect(s.categories.length).toBeGreaterThanOrEqual(4)
    expect(s.categories.length).toBeLessThanOrEqual(8)
    expect(s.clusters.length).toBeGreaterThanOrEqual(15)
    expect(s.clusters.length).toBeLessThanOrEqual(35)
    expect(s.clusters.some((c) => c.id === "cl_other" && c.is_other)).toBe(true)
  })

  it("leaf conversations sum to the total and match the dataset header", () => {
    const sum = s.clusters.reduce((a, c) => a + c.conversations, 0)
    expect(sum).toBe(s.totals.conversations)
    expect(s.dataset.conversations).toBe(s.totals.conversations)
    expect(s.dataset.users).toBe(s.totals.users)
  })

  it("category metrics are consistent with their children", () => {
    for (const cat of s.categories) {
      const kids = s.clusters.filter((c) => c.parent_id === cat.id)
      expect(kids.map((k) => k.id).sort()).toEqual([...(cat.children ?? [])].sort())
      expect(cat.conversations).toBe(kids.reduce((a, k) => a + k.conversations, 0))
      expect(cat.friction.conversations).toBe(kids.reduce((a, k) => a + k.friction.conversations, 0))
      expect(cat.friction.unclear).toBe(kids.reduce((a, k) => a + k.friction.unclear, 0))
      for (const sig of SIGNALS) expect(cat.friction.signals[sig]).toBe(kids.reduce((a, k) => a + k.friction.signals[sig], 0))
      expect(cat.users).toBeGreaterThanOrEqual(Math.max(...kids.map((k) => k.users)))
      expect(cat.users).toBeLessThanOrEqual(kids.reduce((a, k) => a + k.users, 0))
      frictionOk(cat)
    }
    const catUsers = s.categories.map((c) => c.users)
    expect(s.totals.users).toBeGreaterThanOrEqual(Math.max(...catUsers))
    expect(s.totals.users).toBeLessThanOrEqual(catUsers.reduce((a, b) => a + b, 0))
    frictionOk(s.totals)
  })

  it("leaves are well-formed", () => {
    const flagged = s.clusters.filter((c) => c.surprising?.flag)
    expect(flagged.length).toBeGreaterThanOrEqual(3)
    expect(flagged.length).toBeLessThanOrEqual(4)
    for (const c of s.clusters) {
      expect(c.id).toMatch(/^cl_([0-9a-f]{6}|other)$/)
      expect(c.level).toBe(2)
      expect(c.title.split(/\s+/).length).toBeLessThanOrEqual(8)
      expect(c.users).toBeLessThanOrEqual(c.conversations)
      expect(c.share).toBeCloseTo(c.conversations / s.totals.conversations, 4)
      const ids = [...(c.needs ?? []), ...(c.problems ?? [])].map((x) => x.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const n of c.needs ?? []) expect(n.id).toMatch(/^n\d+$/)
      for (const p of c.problems ?? []) expect(p.id).toMatch(/^p\d+$/)
      expect(c.languages.filter((l) => l.name !== "Other languages").length).toBeLessThanOrEqual(5)
      expect(c.languages.reduce((a, l) => a + l.conversations, 0)).toBeLessThanOrEqual(c.conversations)
      const fs = c.friction.share ?? 0
      expect(fs).toBeGreaterThanOrEqual(0.05)
      expect(fs).toBeLessThanOrEqual(0.3)
      frictionOk(c)
    }
    for (const c of s.categories) expect(c.id).toMatch(/^cat_[0-9a-f]{6}$/)
  })

  it("carries no private identifiers", () => {
    const text = JSON.stringify(s)
    expect(text).not.toMatch(/"(c|u|b)_[0-9a-f]{6,}/)
  })

  it("mock results follow the ordering rules and reconcile with the snapshot", () => {
    const u = usageResult(s)
    expect(u.rows).toHaveLength(s.clusters.length)
    for (let i = 1; i < u.rows.length; i++) {
      const [a, b] = [u.rows[i - 1], u.rows[i]]
      expect(a.conversations > b.conversations || (a.conversations === b.conversations && a.cluster_id < b.cluster_id)).toBe(true)
    }
    const f = frictionResult(s)
    for (let i = 1; i < f.rows.length; i++) {
      const [a, b] = [f.rows[i - 1], f.rows[i]]
      expect(a.friction_conversations > b.friction_conversations || (a.friction_conversations === b.friction_conversations && a.cluster_id < b.cluster_id)).toBe(true)
    }
    expect(u.rows.reduce((a, r) => a + r.conversations, 0)).toBe(u.total_conversations)
  })

  it("mock stories are 90–140 words and cite real evidence ids", () => {
    for (const c of s.clusters) {
      const st = mockStory(c)
      const words = st.text.split(/\s+/).filter(Boolean).length
      expect(words, c.title).toBeGreaterThanOrEqual(90)
      expect(words, c.title).toBeLessThanOrEqual(140)
      const ids = new Set([...(c.needs ?? []), ...(c.problems ?? [])].map((x) => x.id))
      for (const cit of st.citations) expect(ids.has(cit)).toBe(true)
    }
  })
})
