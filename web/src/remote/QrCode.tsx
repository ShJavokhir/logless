import { useMemo } from "react"
import { generate } from "lean-qr"
import { toSvgPath } from "lean-qr/extras/svg"

/** Inline SVG so it passes the CSP (img-src allows no remote or generated URLs beyond data:/blob:). */
export function QrCode({ text, className }: { text: string; className?: string }) {
  const { d, size } = useMemo(() => {
    const code = generate(text)
    return { d: toSvgPath(code), size: code.size }
  }, [text])
  const pad = 2
  return (
    <svg
      role="img"
      aria-label="QR code that opens loggy on your phone"
      viewBox={`${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect x={-pad} y={-pad} width={size + pad * 2} height={size + pad * 2} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
