const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

export const UNAVAILABLE = "unavailable"

/** Integer with thousands separators. Non-finite input → "unavailable". */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  return intFmt.format(Math.round(n))
}

/** A 0..1 share as a percentage with one decimal. null → "unavailable". */
export function fmtPct(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return UNAVAILABLE
  return `${(share * 100).toFixed(digits)}%`
}

/** Share computed from counts; a zero/absent denominator → null. */
export function ratio(num: number, denom: number | null | undefined): number | null {
  if (!denom || !Number.isFinite(denom) || !Number.isFinite(num)) return null
  return num / denom
}

/** "18.2% · 148 of 812", or "unavailable" when the denominator is 0/missing. */
export function fmtShareOf(num: number, denom: number | null | undefined): string {
  const r = ratio(num, denom)
  if (r === null) return UNAVAILABLE
  return `${fmtPct(r)} · ${fmtInt(num)} of ${fmtInt(denom)}`
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNAVAILABLE
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${intFmt.format(Math.round(ms))} ms`
}

export function fmtSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNAVAILABLE
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return UNAVAILABLE
  if (b < 1024) return `${fmtInt(b)} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`
  return `${(b / 1024 / 1024).toFixed(1)} MiB`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function parseYmd(s: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
}

/** "Apr 8 – May 4, 2023" from two YYYY-MM-DD strings (no timezone shifts). */
export function fmtDateRange(start: string, end: string): string {
  const a = parseYmd(start)
  const b = parseYmd(end)
  if (!a || !b) return `${start} – ${end}`
  const left = `${MONTHS[a[1]]} ${a[2]}`
  const right = `${MONTHS[b[1]]} ${b[2]}, ${b[0]}`
  return a[0] === b[0] ? `${left} – ${right}` : `${left}, ${a[0]} – ${right}`
}

/** "Sep 27, 2026" from an ISO timestamp (UTC). */
export function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/** "03:14:12.418" (UTC) from an ISO timestamp; keeps millis when present. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const ms = d.getUTCMilliseconds()
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${ms ? `.${p(ms, 3)}` : ""}`
}

/** Milliseconds between two ISO timestamps, or null if either is missing. */
export function durationMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, b - a)
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m} min ${s} s`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`
}
