// Ultrasort before/after: the GLM side is an estimate from past measurements,
// never from this run. Every GLM figure shown to the viewer says "est.".
// Jev's side is only ever the measured time of the real run.
import { fmtDuration, fmtInt } from "./format"

/**
 * GLM on Vultr Serverless Inference, from the repo's own logs (var/):
 * - callsPerMinute: successful GLM calls hit ~120 per clock minute per model
 *   (llm_cache timestamps; glm-5.3 110–118, glm-5.3-flash exactly 120), with
 *   429s beyond that in every full run's log.
 * - secondsPerCall: ~1.2–1.8 s per call at 16 workers (build b_20260927T004302:
 *   70 conversations in 6.3 s; burst windows of ~9 successes/s). Not logged per call.
 * - concurrency: backend glm_concurrency.
 */
export const GLM_BASELINE = { secondsPerCall: 1.5, concurrency: 16, callsPerMinute: 120 } as const

/** Estimated GLM conversations per second: its parallel calls, capped by the rate limit. */
export function glmRate(): number {
  const { secondsPerCall, concurrency, callsPerMinute } = GLM_BASELINE
  return Math.min(concurrency / secondsPerCall, callsPerMinute / 60)
}

/** Estimated seconds for GLM to sort `n` conversations. */
export const glmSeconds = (n: number) => n / glmRate()

export function glmPaceLabel(): string {
  return `GLM est. ${glmRate().toFixed(1)} conversations/s (${GLM_BASELINE.callsPerMinute} calls/min limit)`
}

export function glmEtaLabel(n: number): string {
  return `GLM est. ${fmtDuration(glmSeconds(n) * 1000)} for ${fmtInt(n)}`
}

/** A bin sampler weighted by expected share, for the drip's estimated decisions. */
export function binSampler(weights: number[]): () => number {
  const w = weights.map((x) => Math.max(0, x))
  const sum = w.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  const cdf = w.map((x) => (acc += x / sum))
  return () => {
    const u = Math.random()
    const bin = cdf.findIndex((c) => u <= c)
    return bin < 0 ? w.length - 1 : bin
  }
}

/** `seconds` is Jev's measured time, press to last real event. */
export function resultLine(n: number, seconds: number): string {
  const glm = glmSeconds(n)
  const times = seconds > 0 ? ` (~${fmtInt(Math.round(glm / seconds))}× longer, est.)` : ""
  return `Jev sorted ${fmtInt(n)} in ${fmtDuration(seconds * 1000)}, measured · GLM est. ${fmtDuration(glm * 1000)}${times}`
}

/** The one new colour: Ultrasort violet, plus shades derived from it. */
export const ULTRA = { l: 0.62, c: 0.2, h: 295 } as const
export const ultraCss = (l: number = ULTRA.l, alpha = 1) => `oklch(${l} ${ULTRA.c} ${ULTRA.h}${alpha < 1 ? ` / ${alpha}` : ""})`
