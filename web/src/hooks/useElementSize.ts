import { useLayoutEffect, useState, type RefObject } from "react"

/** Content-box size of an element, kept current with ResizeObserver. */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (w: number, h: number) =>
      setSize((prev) => (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1 ? prev : { width: Math.round(w), height: Math.round(h) }))
    const rect = el.getBoundingClientRect()
    update(rect.width, rect.height)
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) update(box.width, box.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
