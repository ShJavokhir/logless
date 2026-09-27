// Restrained category hues (usage lens) and a separate warm sequential scale
// (friction lens). Friction colour is always paired with a number and ring
// weight in the UI; it is never the only cue.

import type { Signal } from "./types"

// Cool / neutral hue angles so category colour can't be mistaken for friction.
const CATEGORY_HUES = [250, 185, 150, 290, 345, 105, 222, 205]

export type CategoryPalette = { fill: string; leaf: string; leafStroke: string; stroke: string; label: string; dot: string }

export function categoryPalette(index: number, isOther = false): CategoryPalette {
  if (isOther) {
    return {
      fill: "oklch(0.975 0 0)",
      leaf: "oklch(0.945 0.002 250)",
      leafStroke: "oklch(0.8 0.004 250)",
      stroke: "oklch(0.84 0.004 250)",
      label: "oklch(0.48 0.01 250)",
      dot: "oklch(0.7 0.005 250)",
    }
  }
  const h = CATEGORY_HUES[index % CATEGORY_HUES.length]
  return {
    fill: `oklch(0.986 0.006 ${h})`,
    leaf: `oklch(0.93 0.03 ${h})`,
    leafStroke: `oklch(0.79 0.045 ${h})`,
    stroke: `oklch(0.85 0.028 ${h})`,
    label: `oklch(0.43 0.055 ${h})`,
    dot: `oklch(0.64 0.075 ${h})`,
  }
}

// Friction: sequential warm ramp over [0, FRICTION_MAX] share.
export const FRICTION_MAX = 0.4

type Oklch = [number, number, number]
const FRICTION_STOPS: [number, Oklch][] = [
  [0.0, [0.975, 0.018, 95]],
  [0.08, [0.94, 0.055, 88]],
  [0.16, [0.885, 0.095, 74]],
  [0.24, [0.8, 0.125, 58]],
  [0.32, [0.7, 0.13, 45]],
  [0.4, [0.59, 0.125, 36]],
]

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function frictionOklch(share: number | null): Oklch | null {
  if (share === null || !Number.isFinite(share)) return null
  const s = Math.min(Math.max(share, 0), FRICTION_MAX)
  for (let i = 1; i < FRICTION_STOPS.length; i++) {
    const [s1, c1] = FRICTION_STOPS[i]
    const [s0, c0] = FRICTION_STOPS[i - 1]
    if (s <= s1) {
      const t = (s - s0) / (s1 - s0 || 1)
      return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)]
    }
  }
  return FRICTION_STOPS[FRICTION_STOPS.length - 1][1]
}

const css = ([l, c, h]: Oklch) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`

export function frictionFill(share: number | null): string {
  const c = frictionOklch(share)
  return c ? css(c) : "oklch(0.96 0 0)"
}

export function frictionStroke(share: number | null): string {
  const c = frictionOklch(share)
  if (!c) return "oklch(0.75 0 0)"
  return css([Math.max(0.3, c[0] - 0.22), Math.min(0.16, c[1] + 0.03), c[2] - 4])
}

/** Ring weight grows with friction share (secondary, non-colour cue). */
export function frictionRingWidth(share: number | null): number {
  if (share === null || !Number.isFinite(share)) return 1
  const t = Math.min(Math.max(share, 0), FRICTION_MAX) / FRICTION_MAX
  return 0.75 + t * 3.75
}

/** Text on a friction-filled circle: flip to light on the darkest stops. */
export function frictionLabelColor(share: number | null): string {
  const c = frictionOklch(share)
  return c && c[0] < 0.72 ? "oklch(0.99 0 0)" : "oklch(0.2 0.02 40)"
}

export const FRICTION_LEGEND = [0, 0.08, 0.16, 0.24, 0.32, 0.4]

export const SIGNAL_LABEL: Record<Signal, string> = {
  correction: "Correction",
  repeat_request: "Repeated request",
  assistant_limit: "Assistant limit",
  complaint: "Complaint",
}

export function signalName(signal: Signal | null): string {
  return signal ? SIGNAL_LABEL[signal] : "No specific signal"
}

export const SIGNAL_HINT: Record<Signal, string> = {
  correction: "The person corrects a wrong or unwanted answer",
  repeat_request: "The person has to ask again for the same thing",
  assistant_limit: "The assistant says it can't do what was asked",
  complaint: "The person expresses frustration with the assistant",
}
