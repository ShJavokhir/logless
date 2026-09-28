import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { proseName } from "@/lib/labels"
import type { SnapshotIndex } from "@/lib/snapshot"
import { subthemeRefs, type SubthemeRef } from "@/lib/subthemes"
import type { SubthemesResponse } from "@/lib/types"

// One request per snapshot, shared by every component that renders question rows.
const cache = new Map<string, Promise<SubthemesResponse | null>>()

function load(snapshotId: string): Promise<SubthemesResponse | null> {
  let p = cache.get(snapshotId)
  if (!p) {
    p = api.getSubthemes(snapshotId).catch(() => {
      cache.delete(snapshotId) // a snapshot without sub-themes (404) or a failed request: retry next time
      return null
    })
    cache.set(snapshotId, p)
  }
  return p
}

export type GroupNames = {
  /** Display name of a category, workflow or sub-theme id. */
  nameOf: (id: string) => string | undefined
  /** Like index.titleOf, but also resolves sub-theme ids (for filling explanation placeholders). */
  titleOf: (id: string) => string | undefined
  /** Palette of the node, or of the workflow a sub-theme belongs to. */
  paletteOf: SnapshotIndex["paletteOf"]
  /** The workflow a sub-theme belongs to, or undefined for any other id. */
  subtheme: (id: string) => SubthemeRef | undefined
}

/** Names for question result rows, which may be categories, workflows or sub-themes. */
export function useGroupNames(index: SnapshotIndex): GroupNames {
  const snapshotId = index.snapshot.snapshot_id
  const [resp, setResp] = useState<SubthemesResponse | null>(null)
  useEffect(() => {
    let live = true
    load(snapshotId).then((r) => live && setResp(r))
    return () => {
      live = false
    }
  }, [snapshotId])
  return useMemo(() => {
    const refs = subthemeRefs(resp?.snapshot_id === snapshotId ? resp : null, (id) => {
      const n = index.byId.get(id)
      return n ? proseName(n) : undefined
    })
    const nodeName = (id: string) => {
      const n = index.byId.get(id)
      return n ? proseName(n) : undefined
    }
    return {
      nameOf: (id) => refs.get(id)?.name ?? nodeName(id),
      titleOf: (id) => refs.get(id)?.name ?? index.titleOf(id),
      paletteOf: (id) => index.paletteOf(refs.get(id)?.leafId ?? id),
      subtheme: (id) => refs.get(id),
    }
  }, [resp, snapshotId, index])
}
