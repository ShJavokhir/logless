// Small fetch client for the logless web API (docs/CONTRACTS.md §6).
//
// Mock mode: `VITE_MOCK=1` forces the in-browser mock, `VITE_MOCK=0` forces the
// real API. When unset, `pnpm dev` uses the mock and production builds use the
// real API. The mock module is loaded lazily so it stays out of live bundles.

import type {
  AnalysisRequest,
  EvalReport,
  Health,
  Run,
  RunIdResponse,
  SearchRequest,
  SearchResponse,
  Snapshot,
  StoryResponse,
} from "./types"
import { SANDBOX_UNAVAILABLE } from "./copy"

export interface Api {
  readonly mode: "mock" | "live"
  getSnapshot(signal?: AbortSignal): Promise<Snapshot>
  search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>
  startAnalysis(req: AnalysisRequest): Promise<RunIdResponse>
  getRun(runId: string, signal?: AbortSignal): Promise<Run>
  requestStory(clusterId: string, snapshotId: string): Promise<StoryResponse>
  startContainment(): Promise<RunIdResponse>
  getEval(signal?: AbortSignal): Promise<EvalReport>
  getHealth(signal?: AbortSignal): Promise<Health>
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export const MOCK_MODE: boolean =
  import.meta.env.VITE_MOCK === "1" || (import.meta.env.DEV && import.meta.env.VITE_MOCK !== "0")

const BASE = "/api"

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err
    throw new ApiError(0, "network", "The logless API could not be reached.")
  }
  if (!res.ok) {
    let code = `http_${res.status}`
    let message = res.statusText || "Request failed"
    try {
      // Contract: errors are a top-level {code, message}; tolerate {error: {...}} and FastAPI {detail}.
      const data = (await res.json()) as { code?: unknown; message?: unknown; error?: { code?: string; message?: string }; detail?: unknown }
      if (typeof data?.code === "string") code = data.code
      else if (data?.error?.code) code = data.error.code
      if (typeof data?.message === "string") message = data.message
      else if (data?.error?.message) message = data.error.message
      else if (typeof data?.detail === "string") message = data.detail
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, code, message)
  }
  return (await res.json()) as T
}

const live: Api = {
  mode: "live",
  getSnapshot: (signal) => request<Snapshot>("GET", "/snapshot", undefined, signal),
  search: (req, signal) => request<SearchResponse>("POST", "/search", req, signal),
  startAnalysis: (req) => request<RunIdResponse>("POST", "/analyses", req),
  getRun: (runId, signal) => request<Run>("GET", `/runs/${encodeURIComponent(runId)}`, undefined, signal),
  requestStory: (clusterId, snapshotId) =>
    request<StoryResponse>("POST", `/clusters/${encodeURIComponent(clusterId)}/story`, { snapshot_id: snapshotId }),
  startContainment: () => request<RunIdResponse>("POST", "/demo/containment", {}),
  getEval: (signal) => request<EvalReport>("GET", "/eval", undefined, signal),
  getHealth: (signal) => request<Health>("GET", "/health", undefined, signal),
}

let mockPromise: Promise<Api> | null = null
function mock(): Promise<Api> {
  mockPromise ??= import("../mocks/api").then((m) => m.createMockApi())
  return mockPromise
}

function impl(): Promise<Api> {
  return MOCK_MODE ? mock() : Promise.resolve(live)
}

export const api: Api = {
  mode: MOCK_MODE ? "mock" : "live",
  getSnapshot: async (signal) => (await impl()).getSnapshot(signal),
  search: async (req, signal) => (await impl()).search(req, signal),
  startAnalysis: async (req) => (await impl()).startAnalysis(req),
  getRun: async (runId, signal) => (await impl()).getRun(runId, signal),
  requestStory: async (clusterId, snapshotId) => (await impl()).requestStory(clusterId, snapshotId),
  startContainment: async () => (await impl()).startContainment(),
  getEval: async (signal) => (await impl()).getEval(signal),
  getHealth: async (signal) => (await impl()).getHealth(signal),
}

const FRIENDLY: Record<string, string> = {
  sandbox_unreachable: SANDBOX_UNAVAILABLE,
  budget_exhausted:
    "Live questions are paused: this public demo has used its model budget for now. Everything already published is still browsable.",
  rate_limited: "You're asking faster than the demo allows. Wait a few seconds and try again.",
  busy: "Several live runs are already in progress. Try again in a few seconds.",
  model_unavailable: "The model service isn't answering right now, so live analysis is paused. The saved snapshot is still browsable.",
  no_snapshot: "No snapshot has been published yet.",
  snapshot_blocked: "This snapshot is withheld while it is being checked. Try again shortly.",
  stale_snapshot: "A newer snapshot has been published. Reload to see it.",
  no_eval_report: "No evaluation report has been published for this snapshot yet.",
  no_inputs: "This snapshot has no sandbox inputs, so live questions can't run on it.",
  story_rejected: "The story didn't pass the privacy check twice, so nothing is shown.",
  payload_too_large: "That request was too large.",
}

/** Human-readable, honest error message for UI surfaces. */
export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    if (FRIENDLY[err.code]) return FRIENDLY[err.code]
    if (err.status === 0) return "The logless API could not be reached."
    if (err.status === 429) return "Too many requests right now. Try again in a moment."
    if (err.status >= 500) return "The logless API had a problem. The saved snapshot is still browsable."
    return err.message || fallback
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}
