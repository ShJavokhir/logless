// Pure motion helpers shared by every scene (frame in, value out).

import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1)

/** 0 → 1 spring that starts `delay` frames into the scene. */
export function useSpring(delay = 0, damping = 200, durationInFrames?: number) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({ frame: frame - delay, fps, config: { damping }, durationInFrames })
}

/** Eased 0 → 1 progress between two frames of the scene. */
export function useProgress(from: number, to: number) {
  const frame = useCurrentFrame()
  return interpolate(frame, [from, to], [0, 1], { ...clamp, easing: easeOut })
}

/** Deterministic pseudo-random in [0, 1) (no Math.random: frames must be reproducible). */
export function rand(seed: number) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** "glm-5.3" -> "GLM 5.3" for on-screen credits. */
export function modelName(id: string) {
  return id.replace(/^glm-/i, "GLM ").replace(/\s*\(.*\)$/, "")
}
