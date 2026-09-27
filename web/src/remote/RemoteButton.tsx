import { useCallback, useEffect, useState } from "react"
import { LoaderCircle, Smartphone, Unplug } from "lucide-react"
import { describeError } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { END_REASONS, pairingLink, remote, type RemoteSession } from "./api"
import { QrCode } from "./QrCode"

const POLL_MS = 2000

/**
 * Presenter-only header button: opens a remote session and shows its QR code. The session keeps polling while this
 * tab is open (closing the dialog does not end it); the server ends it when this tab stops polling.
 */
export function RemoteButton() {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const live = session && session.status !== "ended"

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setSession(await remote.create())
    } catch (err) {
      setError(describeError(err, "Remote control could not start."))
    } finally {
      setBusy(false)
    }
  }, [])

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && !live && !busy) void start()
  }

  const sid = live ? session.session_id : null
  useEffect(() => {
    if (!sid) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const s = await remote.get(sid, undefined, ctrl.signal)
        setSession(s)
        if (s.status === "ended") return
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
      }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [sid])

  // Ending on tab close is best-effort; the server's idle check is the guarantee.
  useEffect(() => {
    if (!sid) return
    const onHide = () => void remote.end(sid).catch(() => {})
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [sid])

  const end = async () => {
    if (!session) return
    try {
      setSession(await remote.end(session.session_id))
    } catch (err) {
      setError(describeError(err, "The session could not be ended."))
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="relative inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Smartphone aria-hidden className="size-3.5" />
        Remote
        {live ? (
          <span
            aria-label={session.phone_connected ? "Phone connected" : "Waiting for a phone"}
            className={cn("size-2 rounded-full", session.phone_connected ? "bg-ok" : "animate-pulse bg-warn")}
          />
        ) : null}
      </button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-[17px] font-semibold">Ask loggy from your phone</DialogTitle>
            <DialogDescription className="text-[13px]">
              Scan the code with your phone camera. With NetBird, each session gets a URL protected by a session PIN.
              The URL is deleted when the session ends.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">
              {error}
              <Button className="mt-2" size="xs" variant="outline" onClick={() => void start()}>
                Try again
              </Button>
            </div>
          ) : !session || busy ? (
            <p className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground" aria-busy>
              <LoaderCircle className="size-4 animate-spin" /> Opening a session…
            </p>
          ) : session.status === "ended" ? (
            <div className="flex flex-col items-start gap-3 py-4 text-[13px]">
              <p>{END_REASONS[session.end_reason ?? ""] ?? "This session has ended."} Its URL no longer exists.</p>
              <Button size="sm" onClick={() => void start()}>
                New session
              </Button>
            </div>
          ) : (
            <Paired session={session} onEnd={() => void end()} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Paired({ session, onEnd }: { session: RemoteSession; onEnd: () => void }) {
  const link = pairingLink(session)
  const provisioning = session.status === "provisioning"
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0 overflow-hidden rounded-lg border bg-white p-1">
          <QrCode text={link} className={cn("size-44", provisioning && "opacity-20 blur-[2px]")} />
          {provisioning ? (
            <span className="absolute inset-0 grid place-items-center text-center text-[12px] font-medium text-foreground">
              <span className="flex flex-col items-center gap-1.5">
                <LoaderCircle className="size-4 animate-spin" />
                NetBird is bringing
                <br />
                the URL up…
              </span>
            </span>
          ) : null}
        </div>
        <dl className="flex min-w-0 flex-col gap-2.5 text-[12.5px]">
          {session.pin ? (
            <div>
              <dt className="text-muted-foreground">PIN</dt>
              <dd className="font-mono text-[22px] font-semibold tracking-[0.2em]">{session.pin}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">Phone</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <span className={cn("size-2 rounded-full", session.phone_connected ? "bg-ok" : "bg-warn")} />
              {session.phone_connected ? "Connected" : "Waiting for a scan"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">URL</dt>
            <dd className="truncate font-mono text-[11.5px]" title={session.url ?? window.location.origin}>
              {(session.url ?? window.location.origin).replace(/^https?:\/\//, "")}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{new Date(session.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd>
          </div>
        </dl>
      </div>

      {session.thread.length ? (
        <ol aria-label="Questions from the phone" className="flex max-h-40 flex-col gap-1 overflow-y-auto border-t pt-3 text-[12.5px]">
          {session.thread.map((t) => (
            <li key={t.run_id} className="truncate">
              <span className="text-muted-foreground">{new Date(t.asked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{" "}
              “{t.question}”
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-[11.5px] text-muted-foreground">{session.provider === "netbird" ? "Served through NetBird" : "Local mode (no NetBird)"}</span>
        <Button size="sm" variant="destructive" onClick={onEnd}>
          <Unplug />
          End session
        </Button>
      </div>
    </div>
  )
}
