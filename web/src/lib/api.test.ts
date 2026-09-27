import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
})

describe("live API transport", () => {
  it("bounds a hanging request and reports a timeout rather than loading forever", async () => {
    vi.stubEnv("VITE_MOCK", "0")
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    })))
    const { api, REQUEST_TIMEOUT_MS } = await import("./api")
    const pending = api.getSnapshot()
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await assertion
  })
  it("preserves caller cancellation rather than displaying a network error", async () => {
    vi.stubEnv("VITE_MOCK", "0")
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    })))
    const { api } = await import("./api")
    const ctrl = new AbortController()
    const pending = api.getSnapshot(ctrl.signal)
    await Promise.resolve()
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})
