// Remote control (backend/logless/api/remote.py): the desktop (presenter) opens a session and shows a QR code,
// the phone holds the session token from that code and sends it as X-Loggy-Token. Live API only; no mock.
import { request } from "@/lib/api"

export type RemoteTurn = { question: string; run_id: string; asked_at: string }

export type RemoteSession = {
  session_id: string
  status: "provisioning" | "ready" | "ended"
  provider: "netbird" | "local"
  /** phone origin (the per-session NetBird URL); null = the desktop's own origin */
  url: string | null
  expires_at: string
  phone_connected: boolean
  end_reason: string | null
  thread: RemoteTurn[]
  /** desktop view only */
  token?: string
  pin?: string | null
}

const path = (sid: string) => `/remote/sessions/${encodeURIComponent(sid)}`
const auth = (token?: string) => (token ? { "X-Loggy-Token": token } : undefined)

export const remote = {
  create: () => request<RemoteSession>("POST", "/remote/sessions", {}),
  get: (sid: string, token?: string, signal?: AbortSignal) => request<RemoteSession>("GET", path(sid), undefined, signal, auth(token)),
  ask: (sid: string, token: string, question: string) =>
    request<{ run_id: string }>("POST", `${path(sid)}/questions`, { question }, undefined, auth(token)),
  end: (sid: string, token?: string) => request<RemoteSession>("DELETE", path(sid), undefined, undefined, auth(token)),
}

/** The link the QR code carries. The token rides in the hash so it never reaches a server or proxy log. */
export function pairingLink(s: RemoteSession): string {
  return `${s.url ?? window.location.origin}/#/remote/${s.session_id}/${s.token}`
}

export const END_REASONS: Record<string, string> = {
  desktop_disconnected: "The desktop ended this session.",
  phone_disconnected: "The phone disconnected.",
  expired: "The session reached its time limit.",
  desktop_gone: "The desktop that opened this session went away.",
  server_stopped: "The logless server restarted.",
  netbird_timeout: "NetBird didn't bring the URL up in time.",
  netbird_certificate_failed: "NetBird couldn't get a certificate for this URL.",
  netbird_error: "NetBird reported an error for this URL.",
}
