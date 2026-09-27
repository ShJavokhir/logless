import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { ArrowUp, LoaderCircle, Unplug } from "lucide-react"
import { ApiError, api, describeError } from "@/lib/api"
import { EXAMPLE_QUESTIONS } from "@/lib/copy"
import { indexSnapshot, type SnapshotIndex } from "@/lib/snapshot"
import type { Snapshot } from "@/lib/types"
import { useRun, isTerminal } from "@/hooks/useRun"
import { Button } from "@/components/ui/button"
import { Wordmark } from "@/components/Chrome"
import { AnswerCard } from "@/components/AnswerCard"
import { RunDetailsSheet } from "@/components/RunDetailsSheet"
import { END_REASONS, remote, type RemoteSession, type RemoteTurn } from "./api"

const POLL_MS = 2000
const noop = () => {}

/** The token from the QR code lives in sessionStorage for this tab, never in the address bar or history. */
function useSessionToken(sessionId: string, fromHash: string | null): string | null {
  return useMemo(() => {
    const key = `logless.remote.${sessionId}`
    try {
      if (fromHash) sessionStorage.setItem(key, fromHash)
      if (fromHash) window.history.replaceState(null, "", `#/remote/${sessionId}`)
      return fromHash ?? sessionStorage.getItem(key)
    } catch {
      return fromHash
    }
  }, [sessionId, fromHash])
}

type State = { kind: "loading" } | { kind: "live"; session: RemoteSession } | { kind: "gone" }

export default function RemoteChat({ sessionId, token: fromHash }: { sessionId: string; token: string | null }) {
  const token = useSessionToken(sessionId, fromHash)
  const [state, setState] = useState<State>(token ? { kind: "loading" } : { kind: "gone" })
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    api.getSnapshot(ctrl.signal).then(setSnapshot, () => {})
    return () => ctrl.abort()
  }, [])
  const index = useMemo(() => (snapshot ? indexSnapshot(snapshot) : null), [snapshot])

  // Polling is also the phone's heartbeat: the desktop shows "connected" from it.
  const ended = state.kind === "live" && state.session.status === "ended"
  useEffect(() => {
    if (!token || ended) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const session = await remote.get(sessionId, token, ctrl.signal)
        setState({ kind: "live", session })
        if (session.status === "ended") return
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
        if (err instanceof ApiError && err.status === 404) return setState({ kind: "gone" })
      }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [sessionId, token, ended])

  const thread = state.kind === "live" ? state.session.thread : []
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [thread.length, pending])

  const ask = async (question: string) => {
    if (!token) return
    setPending(question)
    setError(null)
    try {
      await remote.ask(sessionId, token, question.slice(0, 200))
      const session = await remote.get(sessionId, token)
      setState({ kind: "live", session })
    } catch (err) {
      setError(describeError(err, "The question could not be sent."))
    } finally {
      setPending(null)
    }
  }

  const disconnect = async () => {
    if (!token) return
    try {
      setState({ kind: "live", session: await remote.end(sessionId, token) })
    } catch (err) {
      setError(describeError(err, "Could not disconnect."))
    }
  }

  const session = state.kind === "live" ? state.session : null
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <Wordmark />
        <span className="text-[12.5px] text-muted-foreground">loggy remote</span>
        {session && !ended ? (
          <Button className="ml-auto" size="sm" variant="ghost" onClick={() => void disconnect()}>
            <Unplug />
            Disconnect
          </Button>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {state.kind === "gone" ? (
          <Notice title="This session doesn't exist anymore">Scan a new code on the desktop to pair again.</Notice>
        ) : state.kind === "loading" || !index ? (
          <p className="flex items-center gap-2 p-6 text-[13px] text-muted-foreground" aria-busy>
            <LoaderCircle className="size-4 animate-spin" /> Connecting…
          </p>
        ) : (
          <div className="mx-auto flex max-w-[640px] flex-col gap-3">
            {thread.length === 0 && !pending ? (
              <section className="rounded-xl border bg-card px-4 py-4">
                <h1 className="text-[15px] font-semibold">Ask loggy about the published map</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  loggy writes two programs, runs them in a sandbox, and shows only what the gate verifies.
                </p>
                {!ended ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {EXAMPLE_QUESTIONS.map((q) => (
                      <button key={q} type="button" onClick={() => void ask(q)} className="rounded-full border px-2.5 py-1 text-left text-[12px] hover:bg-muted">
                        {q}
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {thread.map((t) => (
              <Turn key={t.run_id} turn={t} index={index} />
            ))}
            {pending ? <AnswerCard run={null} error={null} asking index={index} selectedId={null} onSelectCluster={noop} onFocusCategory={noop} onPeek={noop} onOpenDetails={noop} /> : null}
            {error ? <p role="alert" className="px-1 text-[12.5px] text-destructive">{error}</p> : null}
            {ended ? (
              <Notice title="Session ended">{END_REASONS[session?.end_reason ?? ""] ?? "This session has ended."} Its URL has been deleted.</Notice>
            ) : null}
            <div ref={bottom} />
          </div>
        )}
      </main>

      {session && !ended ? <Composer disabled={!!pending} onAsk={(q) => void ask(q)} /> : null}
    </div>
  )
}

function Turn({ turn, index }: { turn: RemoteTurn; index: SnapshotIndex }) {
  const { run, error } = useRun(turn.run_id)
  const [details, setDetails] = useState(false)
  return (
    <>
      <AnswerCard
        run={run}
        error={error}
        asking={!run && !error}
        index={index}
        selectedId={null}
        onSelectCluster={noop}
        onFocusCategory={noop}
        onPeek={noop}
        onOpenDetails={() => setDetails(true)}
      />
      {run && isTerminal(run) ? <RunDetailsSheet open={details} onOpenChange={setDetails} run={run} snapshot={index.snapshot} /> : null}
    </>
  )
}

function Composer({ disabled, onAsk }: { disabled: boolean; onAsk: (q: string) => void }) {
  const [text, setText] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = text.trim()
    if (!q || disabled) return
    onAsk(q)
    setText("")
  }
  return (
    <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t bg-card px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      <label htmlFor="remote-ask" className="sr-only">
        Ask loggy
      </label>
      <input
        id="remote-ask"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={200}
        placeholder="Ask loggy…"
        autoComplete="off"
        className="h-10 min-w-0 flex-1 rounded-full border bg-background px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <Button type="submit" size="icon" className="size-10 rounded-full" disabled={disabled || !text.trim()} aria-label="Send">
        {disabled ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
      </Button>
    </form>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section role="status" className="mx-auto max-w-md rounded-xl border bg-card p-5 text-center">
      <h1 className="text-[15px] font-semibold">{title}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">{children}</p>
    </section>
  )
}
