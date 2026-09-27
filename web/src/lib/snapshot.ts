import { categoryPalette, type CategoryPalette } from "./colors"
import type { Node as SnapshotNode, Snapshot } from "./types"

export type SnapshotIndex = {
  snapshot: Snapshot
  byId: Map<string, SnapshotNode>
  categories: SnapshotNode[] // sorted by conversations desc
  leaves: SnapshotNode[] // sorted by conversations desc
  palette: Map<string, CategoryPalette> // category id -> palette
  leavesOf: (categoryId: string) => SnapshotNode[]
  parentOf: (leafId: string) => SnapshotNode | undefined
  paletteOf: (id: string) => CategoryPalette
  titleOf: (id: string) => string | undefined
}

const desc = (a: SnapshotNode, b: SnapshotNode) => b.conversations - a.conversations || a.id.localeCompare(b.id)

/**
 * `hueOrder` pins category hues to an earlier snapshot's ranking, so colours
 * don't swap when an update changes category sizes.
 */
export function indexSnapshot(snapshot: Snapshot, hueOrder?: Map<string, number>): SnapshotIndex {
  const byId = new Map<string, SnapshotNode>()
  for (const n of snapshot.categories) byId.set(n.id, n)
  for (const n of snapshot.clusters) byId.set(n.id, n)
  const categories = [...snapshot.categories].sort(desc)
  const leaves = [...snapshot.clusters].sort(desc)
  const palette = new Map<string, CategoryPalette>()
  let hueIdx = 0
  const hueSorted = hueOrder ? [...categories].sort((a, b) => (hueOrder.get(a.id) ?? 1e9) - (hueOrder.get(b.id) ?? 1e9)) : categories
  for (const c of hueSorted) palette.set(c.id, categoryPalette(c.is_other ? 0 : hueIdx++, !!c.is_other))
  const grouped = new Map<string, SnapshotNode[]>()
  for (const l of leaves) {
    if (!l.parent_id) continue
    const list = grouped.get(l.parent_id) ?? []
    list.push(l)
    grouped.set(l.parent_id, list)
  }
  const fallback = categoryPalette(0, true)
  return {
    snapshot,
    byId,
    categories,
    leaves,
    palette,
    leavesOf: (id) => grouped.get(id) ?? [],
    parentOf: (id) => {
      const p = byId.get(id)?.parent_id
      return p ? byId.get(p) : undefined
    },
    paletteOf: (id) => {
      const n = byId.get(id)
      const catId = n?.level === 2 ? n.parent_id : id
      return (catId && palette.get(catId)) || (n?.is_other ? fallback : fallback)
    },
    titleOf: (id) => byId.get(id)?.title,
  }
}

/** Languages with "Other languages" always last, whatever the API order. */
export function orderedLanguages(langs: SnapshotNode["languages"]) {
  const other = langs.filter((l) => /^other/i.test(l.name))
  const named = langs.filter((l) => !/^other/i.test(l.name)).sort((a, b) => b.conversations - a.conversations)
  return [...named, ...other]
}

/** Friendly model labels for the provenance footer. */
export function modelLabel(id: string): string {
  const lower = id.toLowerCase()
  if (lower.startsWith("glm")) return `GLM ${id.replace(/^glm-?/i, "").replace(/-/g, " ")} (Vultr Serverless Inference)`.replace("GLM  ", "GLM ")
  if (lower.startsWith("jev")) return "Jev (TypeSafe)"
  if (lower.includes("qwen3-embedding")) return `${id.split("/").pop()} (Fireworks)`
  return id
}

export function uniqueModelLabels(models: Record<string, string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const order = (id: string) => (id.startsWith("glm") ? 0 : id.startsWith("jev") ? 1 : 2)
  for (const id of Object.values(models).sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const label = modelLabel(id)
    if (!seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out
}
