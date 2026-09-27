// Visual language of the brief: the app's category hues and warm friction ramp,
// lifted onto a dark stage so the piece reads as motion graphics.

import { frictionOklch } from "../lib/colors"

export const FONT = '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif'
export const MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

export const C = {
  bg: "oklch(0.155 0.008 265)",
  bgRaised: "oklch(0.2 0.01 265)",
  line: "oklch(0.3 0.012 265)",
  text: "oklch(0.97 0.004 265)",
  muted: "oklch(0.72 0.012 265)",
  faint: "oklch(0.5 0.012 265)",
  friction: "oklch(0.74 0.16 50)",
  frictionSoft: "oklch(0.74 0.16 50 / 0.18)",
  accent: "oklch(0.8 0.12 185)",
}

const HUES = [250, 185, 150, 290, 345, 105, 222, 205]

/** Bright variant of the app's category hue for index i (grey for Other). */
export function hue(i: number, isOther = false, alpha = 1) {
  if (isOther) return `oklch(0.62 0.01 265 / ${alpha})`
  return `oklch(0.78 0.11 ${HUES[i % HUES.length]} / ${alpha})`
}

/** The app's friction ramp, brightened for a dark background. */
export function frictionColor(share: number | null, alpha = 1) {
  const c = frictionOklch(share)
  if (!c) return `oklch(0.6 0 0 / ${alpha})`
  return `oklch(${Math.max(0.62, c[0] - 0.08).toFixed(3)} ${Math.max(0.07, c[1] + 0.03).toFixed(3)} ${c[2].toFixed(1)} / ${alpha})`
}

export const pct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(digits)}%`
export const int = (x: number) => Math.round(x).toLocaleString("en-US")
