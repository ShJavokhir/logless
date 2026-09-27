// Presenter capacity (CONTRACTS §8b): `?presenter=<key>` is read once, kept in
// localStorage and sent as `X-Logless-Presenter` on every API call. The key is
// never rendered or logged, and it is removed from the address bar right away.

const STORAGE_KEY = "logless.presenter"
let cached: string | null | undefined

/** Call once at startup, before the first API request. */
export function capturePresenterKey(): void {
  if (typeof window === "undefined") return
  try {
    const url = new URL(window.location.href)
    const key = url.searchParams.get("presenter")
    if (key === null) return
    url.searchParams.delete("presenter")
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
    const trimmed = key.trim()
    cached = trimmed || null
    try {
      if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed)
      else window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // storage unavailable: keep the key in memory for this tab only
    }
  } catch {
    // malformed URL: ignore
  }
}

export function presenterKey(): string | null {
  if (cached !== undefined) return cached
  try {
    cached = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null
  } catch {
    cached = null
  }
  return cached
}

/** Headers to merge into every API request. */
export function presenterHeaders(): Record<string, string> {
  const key = presenterKey()
  return key ? { "X-Logless-Presenter": key } : {}
}
