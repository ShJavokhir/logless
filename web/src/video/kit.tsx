// Motion primitives shared by every scene. Everything is a pure function of the
// current frame, so the Player and a server-side render produce identical frames.

import type { CSSProperties, ReactNode } from "react"
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { clamp, easeOut, useProgress, useSpring } from "./anim"
import { C, FONT, MONO } from "./theme"

/** Scene wrapper: fades and lifts in, fades out over the last frames. */
export function Stage({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp)
  const inn = interpolate(frame, [0, 12], [0, 1], { ...clamp, easing: easeOut })
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(out, inn),
        transform: `translateY(${(1 - inn) * 18}px) scale(${1 + (1 - out) * 0.015})`,
        padding: "140px 120px 124px",
        fontFamily: FONT,
        color: C.text,
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  )
}

/** Headline revealed word by word. */
export function Headline({
  text,
  delay = 4,
  size = 76,
  maxWidth = 1500,
  color = C.text,
  align = "left",
}: {
  text: string
  delay?: number
  size?: number
  maxWidth?: number
  color?: string
  align?: "left" | "center"
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const words = text.split(/\s+/).filter(Boolean)
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: 620,
        letterSpacing: "-0.035em",
        lineHeight: 1.04,
        maxWidth,
        textAlign: align,
        color,
        textWrap: "balance",
      }}
    >
      {words.map((w, i) => {
        const s = spring({ frame: frame - delay - i * 2.2, fps, config: { damping: 200 } })
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: s,
              transform: `translateY(${(1 - s) * 0.45}em)`,
              filter: `blur(${(1 - s) * 6}px)`,
              marginRight: "0.24em",
            }}
          >
            {w}
          </span>
        )
      })}
    </div>
  )
}

/** Small uppercase label above a headline. */
export function Eyebrow({ children, color = C.muted, delay = 0 }: { children: ReactNode; color?: string; delay?: number }) {
  const s = useSpring(delay)
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 22,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color,
        opacity: s,
        marginBottom: 22,
      }}
    >
      {children}
    </div>
  )
}

/** A number counting up to `value`, formatted by `format`. */
export function CountUp({
  value,
  format,
  from = 0,
  delay = 0,
  duration = 40,
  style,
}: {
  value: number
  format: (x: number) => string
  from?: number
  delay?: number
  duration?: number
  style?: CSSProperties
}) {
  const t = useProgress(delay, delay + duration)
  const v = from + (value - from) * t
  // Reserve the final width so the layout doesn't jitter while counting.
  return (
    <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", display: "inline-grid", ...style }}>
      <span style={{ gridArea: "1/1", visibility: "hidden" }}>{format(value)}</span>
      <span style={{ gridArea: "1/1" }}>{format(t >= 1 ? value : v)}</span>
    </span>
  )
}
