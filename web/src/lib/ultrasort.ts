import { fmtInt } from "@/lib/format"

/**
 * Modelled GLM 5.3 Flash classification pace for the "before" drip. This is an
 * estimate, not a measurement: nobody has timed per-conversation GLM calls for
 * this workload (the snapshot's facets stage was cached). 10 concurrent calls
 * at ~1.5 s each ≈ 6.7 conversations/s.
 */
export const GLM_BASELINE = { concurrency: 10, secondsPerCall: 1.5 } as const

/** Estimated GLM conversations per second. */
export const glmRate = () => GLM_BASELINE.concurrency / GLM_BASELINE.secondsPerCall

/** Estimated seconds for GLM to sort `n` conversations. */
export const glmSeconds = (n: number) => n / glmRate()

/** The one new colour: Ultrasort violet, plus shades derived from it. */
export const ULTRA = { l: 0.62, c: 0.2, h: 295 } as const
export const ultraCss = (l: number = ULTRA.l, alpha = 1) => `oklch(${l} ${ULTRA.c} ${ULTRA.h}${alpha < 1 ? ` / ${alpha}` : ""})`

/** "9.8 s", "3 m 12 s", "4 h 10 m". */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const m = Math.round(seconds / 60)
  if (seconds < 3600) return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`
  return `${Math.floor(m / 60)} h ${m % 60} m`
}

/** Drip HUD: "GLM 5.3 Flash · est. 6.7/s". */
export const glmPaceLabel = () => `GLM 5.3 Flash · est. ${glmRate().toFixed(1)}/s`

/** Drip HUD: "≈ 4 h 10 m to sort 100,000". */
export const glmEtaLabel = (n: number) => `≈ ${fmtDuration(glmSeconds(n))} to sort ${fmtInt(n)}`

/** "100,000 sorted in 9.8 s · GLM 5.3 Flash est. 4 h 10 m"; `jevSeconds` must come from measured timestamps. */
export const resultLine = (n: number, jevSeconds: number) => `${fmtInt(n)} sorted in ${fmtDuration(jevSeconds)} · GLM 5.3 Flash est. ${fmtDuration(glmSeconds(n))}`
