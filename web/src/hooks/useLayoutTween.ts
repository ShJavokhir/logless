import { useEffect, useState } from "react"
import { lerpLayout, type PackedLayout } from "@/lib/hierarchy"
import { easeInOutCubic } from "@/lib/intake"

type Anim = { from: PackedLayout | null; to: PackedLayout | null; start: number | null }

/**
 * When the layout changes at the same container size (a new snapshot), glide
 * circles from their old positions/sizes to the new ones over `ms`. Resizes
 * and reduced motion switch instantly.
 */
export function useLayoutTween(layout: PackedLayout | null, ms = 600, reduced = false): PackedLayout | null {
  const [anim, setAnim] = useState<Anim>({ from: null, to: layout, start: null })
  const [now, setNow] = useState(0)
  const progress = anim.start === null ? 0 : Math.min(1, Math.max(0, (now - anim.start) / ms))

  if (anim.to !== layout) {
    // derived-state update during render (React's documented pattern)
    const sameSize = !!anim.to && !!layout && anim.to.width === layout.width && anim.to.height === layout.height
    const current = anim.from && anim.to ? lerpLayout(anim.from, anim.to, easeInOutCubic(progress)) : anim.to
    setAnim({ from: sameSize && !reduced ? current : null, to: layout, start: null })
  }

  useEffect(() => {
    if (!anim.from) return
    let raf = 0
    const step = (t: number) => {
      setNow(t)
      setAnim((a) => (a.start === null ? { ...a, start: t } : t - a.start >= ms ? { ...a, from: null } : a))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [anim.from, ms])

  if (!anim.from || !anim.to) return layout
  return lerpLayout(anim.from, anim.to, easeInOutCubic(progress))
}
