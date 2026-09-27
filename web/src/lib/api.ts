// Small fetch client for the logless web API (docs/CONTRACTS.md §6).
//
// Mock mode: `VITE_MOCK=1` forces the in-browser mock, `VITE_MOCK=0` forces the
// real API. When unset, `pnpm dev` uses the mock and production builds use the
// real API. The mock module is loaded lazily so it stays out of live bundles.

import type {
  AnalysisRequest,
  EvalReport,
  Health,
  IntakeEventsResponse,
  IntakeStatus,
  Run,
  RunIdResponse,
  SearchRequest,
  SearchResponse,
  Snapshot,
  StoryResponse,
  PrdResponse,
} from "./types"
import type { BriefResponse } from "@/video/types"
import { SANDBOX_UNAVAILABLE } from "./copy"
import { presenterHeaders } from "./presenter"

export interface Api {
  readonly mode: "mock" | "live"
  getSnapshot(signal?: AbortSignal): Promise<Snapshot>
  search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>
  startAnalysis(req: AnalysisRequest): Promise<RunIdResponse>
  getRun(runId: string, signal?: AbortSignal): Promise<Run>
  requestStory(clusterId: string, snapshotId: string): Promise<StoryResponse>
  requestPrd(clusterId: string, snapshotId: string): Promise<PrdResponse>
  getBrief(snapshotId: string, signal?: AbortSignal): Promise<BriefResponse>
  requestBrief(snapshotId: string, regenerate: boolean): Promise<BriefResponse>
  startContainment(): Promise<RunIdResponse>
  getEval(signal?: AbortSignal): Promise<EvalReport>
  getHealth(signal?: AbortSignal): Promise<Health>
  // §11 live intake (start/reset are presenter-only; the server enforces the key)
  getIntakeStatus(signal?: AbortSignal): Promise<IntakeStatus>
  startIntake(): Promise<RunIdResponse>
  getIntakeEvents(runId: string, after: number, signal?: AbortSignal): Promise<IntakeEventsResponse>
  resetIntake(): Promise<{ ok?: boolean } | Record<string, unknown>>
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
export const REQUEST_TIMEOUT_MS = 30_000

type Method = "GET" | "POST" | "DELETE"

export async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  const timeout = new AbortController()
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetchJson<T>(method, path, body, combined, headers)
  } catch (err) {
    if (timeout.signal.aborted && !signal?.aborted) throw new ApiError(0, "timeout", "The API took too long to respond. Try again.")
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...presenterHeaders(), ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
  requestPrd: (clusterId, snapshotId) =>
    request<PrdResponse>("POST", `/clusters/${encodeURIComponent(clusterId)}/prd`, { snapshot_id: snapshotId }),
  getBrief: (snapshotId, signal) => request<BriefResponse>("GET", `/brief?snapshot_id=${encodeURIComponent(snapshotId)}`, undefined, signal),
  requestBrief: (snapshotId, regenerate) => request<BriefResponse>("POST", "/brief", { snapshot_id: snapshotId, regenerate }),
  startContainment: () => request<RunIdResponse>("POST", "/demo/containment", {}),
  getEval: (signal) => request<EvalReport>("GET", "/eval", undefined, signal),
  getHealth: (signal) => request<Health>("GET", "/health", undefined, signal),
  getIntakeStatus: (signal) => request<IntakeStatus>("GET", "/intake/status", undefined, signal),
  startIntake: () => request<RunIdResponse>("POST", "/intake/runs", {}),
  getIntakeEvents: (runId, after, signal) =>
    request<IntakeEventsResponse>("GET", `/intake/runs/${encodeURIComponent(runId)}/events?after=${Math.max(0, Math.floor(after))}`, undefined, signal),
  resetIntake: () => request<Record<string, unknown>>("POST", "/intake/reset", {}),
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
  requestPrd: async (clusterId, snapshotId) => (await impl()).requestPrd(clusterId, snapshotId),
  getBrief: async (snapshotId, signal) => (await impl()).getBrief(snapshotId, signal),
  requestBrief: async (snapshotId, regenerate) => (await impl()).requestBrief(snapshotId, regenerate),
  startContainment: async () => (await impl()).startContainment(),
  getEval: async (signal) => (await impl()).getEval(signal),
  getHealth: async (signal) => (await impl()).getHealth(signal),
  getIntakeStatus: async (signal) => (await impl()).getIntakeStatus(signal),
  startIntake: async () => (await impl()).startIntake(),
  getIntakeEvents: async (runId, after, signal) => (await impl()).getIntakeEvents(runId, after, signal),
  resetIntake: async () => (await impl()).resetIntake(),
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
  invalid_request: "That request wasn't accepted. Questions need 1–200 characters.",
  presenter_required: "Live intake is presenter-only.",
  intake_not_ready: "No intake batch is prepared right now.",
  intake_in_flight: "A live intake is already running.",
  stale_intake: "The published snapshot changed. Reload the map before starting or resetting intake.",
  timeout: "The API took too long to respond. Try again.",
  interpretation_failed: "The question couldn't be interpreted this time. Try rephrasing it.",
  prd_rejected: "The PRD draft didn't pass validation twice, so nothing is shown.",
  brief_rejected: "The director's storyboard didn't pass the checks twice, so no new cut is shown.",
  story_rejected: "The story didn't pass the privacy check twice, so nothing is shown.",
  payload_too_large: "That request was too large.",
  too_many_sessions: "Three remote sessions are already open. End one first.",
  remote_unavailable: "Remote control isn't set up on this server (NetBird is not configured).",
  netbird_failed: "NetBird could not provision a URL for this session. Try again.",
  session_ended: "This remote session has ended. Scan a new code on the desktop.",
  question_limit: "This session has used its 20 questions. Scan a new code for more.",
  question_in_flight: "loggy is still answering the last question.",
}

const PAUSE_CODES = new Set(["budget_exhausted", "rate_limited", "busy", "sandbox_unreachable", "model_unavailable"])

/** True for "try later" conditions (quota, rate limit, capacity), as opposed to a failed run. */
export function isPause(err: unknown): boolean {
  return err instanceof ApiError && (PAUSE_CODES.has(err.code) || err.status === 429)
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
