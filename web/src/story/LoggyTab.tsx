import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  ArrowRight,
  ArrowUp,
  Ban,
  Check,
  Code,
  FileCode,
  LoaderCircle,
  MessageSquareWarning,
  Mic,
  Sparkles,
  Square,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react"
import { api, describeError, isPause } from "@/lib/api"
import type { QuestionResult, Run } from "@/lib/types"
import type { SnapshotIndex } from "@/lib/snapshot"
import { deriveSteps, hasVerifiedResult, isRunActive, runDurationMs, type Step, type StepKey, type StepStatus } from "@/lib/runs"
import { fillTemplate, segmentsToString, type Segment } from "@/lib/template"
import { fmtDuration, fmtInt, fmtMs, fmtPct } from "@/lib/format"
import { planToPhrases } from "@/lib/plan"
import { proseName } from "@/lib/labels"
import { EXAMPLE_QUESTIONS } from "@/lib/copy"
import { crossChecks, PROGRAM_KIND, programTracks } from "@/lib/programs"
import { cn } from "@/lib/utils"
import { useRun } from "@/hooks/useRun"
import { canSpeak, speak, stopSpeaking, useDictation } from "@/hooks/useVoice"
import { Button } from "@/components/ui/button"
import { Dot } from "@/components/common"
import { RunDetailsSheet } from "@/components/RunDetailsSheet"
import type { BuildTarget } from "./BuildTab"
import { DetailPanel } from "@/components/DetailPanel"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

const AnswerCanvas = lazy(() => import("@/components/AnswerCanvas").then((module) => ({ default: module.AnswerCanvas })))

type Turn = {
  id: string
  question: string
  via: "voice" | "text"
  runId: string | null
  sending: boolean
  error: { message: string; paused: boolean } | null
  startedAt: number
}

let nextId = 1
const REDUCED = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

export function LoggyTab({ index, active, onBuild }: { index: SnapshotIndex; active: boolean; onBuild: (t: BuildTarget) => void }) {
  const snapshotId = index.snapshot.snapshot_id
  const [turns, setTurns] = useState<Turn[]>([])
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)

  const patch = (id: string, p: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)))
  const ask = useCallback(
    async (text: string, via: Turn["via"]) => {
      const question = text.trim().slice(0, 200)
      if (!question) return
      const id = `t${nextId++}`
      setTurns((ts) => [...ts, { id, question, via, runId: null, sending: true, error: null, startedAt: Date.now() }])
      setSelected(id)
      try {
        const { run_id } = await api.startAnalysis({ intent: "question", question, snapshot_id: snapshotId })
        patch(id, { runId: run_id, sending: false })
      } catch (err) {
        patch(id, { sending: false, error: { message: describeError(err, "The question could not be sent."), paused: isPause(err) } })
      }
    },
    [snapshotId],
  )
  const onRun = useCallback((id: string, run: Run) => setRuns((r) => (r[id] === run ? r : { ...r, [id]: run })), [])
  const say = useCallback((id: string, text: string) => {
    setSpeakingId(id)
    speak(text, () => setSpeakingId((s) => (s === id ? null : s)))
  }, [])
  const hush = useCallback(() => {
    stopSpeaking()
    setSpeakingId(null)
  }, [])

  const last = turns.at(-1)
  const busy = !!last && (last.sending || (!!last.runId && (!runs[last.id] || isRunActive(runs[last.id]))))
  const selectedTurn = turns.find((t) => t.id === selected) ?? last ?? null
  const selectedRun = selectedTurn ? (runs[selectedTurn.id] ?? null) : null

  // Leaving the tab silences Loggy; the utterance's end event clears the speaking state.
  useEffect(() => {
    if (!active) stopSpeaking()
  }, [active])

  // Follow the conversation as it grows (streamed words, new rows), unless the reader scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTo({ top: el.scrollHeight, behavior: REDUCED ? "auto" : "smooth" })
    })
    el.addEventListener("scroll", onScroll, { passive: true })
    ro.observe(content)
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [])
  useEffect(() => {
    stick.current = true
  }, [turns.length])

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
      <section aria-label="Chat with Loggy" className="flex min-h-0 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex max-w-[760px] flex-col gap-7 px-4 py-8 sm:px-6">
            {turns.length ? (
              turns.map((t) => (
                <TurnView
                  key={t.id}
                  turn={t}
                  index={index}
                  selected={selectedTurn?.id === t.id && turns.length > 1}
                  speaking={speakingId === t.id}
                  speakReply={voiceReplies && t.via === "voice"}
                  onSay={say}
                  onRun={onRun}
                  onSelect={() => setSelected(t.id)}
                  onAsk={(q) => void ask(q, "text")}
                  onBuild={onBuild}
                />
              ))
            ) : (
              <Welcome index={index} listening={listening} onAsk={(q) => void ask(q, "text")} />
            )}
          </div>
        </div>
        <div className="relative shrink-0 px-4 pb-5 sm:px-6">
          {speakingId ? (
            <div className="absolute inset-x-0 -top-12 flex justify-center">
              <button
                type="button"
                onClick={hush}
                className="flex animate-in items-center gap-2.5 rounded-full border bg-card py-1.5 pr-2 pl-3 text-[13px] shadow-md duration-200 fade-in-0 slide-in-from-bottom-2 hover:bg-muted"
              >
                <Bars count={4} className="h-3.5 gap-[2px]" barClassName="w-[3px] bg-brand" />
                Loggy is speaking
                <span className="grid size-6 place-items-center rounded-full bg-muted">
                  <Square className="size-2.5 fill-current" />
                </span>
              </button>
            </div>
          ) : null}
          <Composer
            active={active}
            busy={busy}
            voiceReplies={voiceReplies}
            onVoiceReplies={(v) => {
              if (!v) hush()
              setVoiceReplies(v)
            }}
            onListening={setListening}
            onAsk={(q, via) => {
              hush()
              void ask(q, via)
            }}
          />
        </div>
      </section>

      <aside aria-label="Under the hood" className="hidden min-h-0 overflow-y-auto border-l bg-card lg:block">
        <UnderTheHood run={selectedRun} question={selectedTurn?.question ?? null} index={index} onOpenDetails={() => setSheetOpen(true)} />
      </aside>
      <RunDetailsSheet open={sheetOpen} onOpenChange={setSheetOpen} run={selectedRun} snapshot={index.snapshot} />
    </div>
  )
}

// ---------------------------------------------------------------- Loggy's face

export type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy"

export function LoggyAvatar({ size = 28, mood = "idle", float = false }: { size?: number; mood?: Mood; float?: boolean }) {
  const eyes =
    mood === "happy" ? (
      <g className="loggy-part loggy-pop" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M9.6 17.4 q2.4 -3 4.8 0" />
        <path d="M17.6 17.4 q2.4 -3 4.8 0" />
      </g>
    ) : (
      <g className={cn("loggy-part", mood === "thinking" ? "loggy-scan" : mood === "listening" ? "loggy-wide" : "loggy-blink")}>
        <circle cx="12" cy="16.5" r="2.4" fill="currentColor" />
        <circle cx="20" cy="16.5" r="2.4" fill="currentColor" />
      </g>
    )
  const lit = mood === "thinking" || mood === "listening"
  return (
    <span aria-hidden className={cn("relative grid shrink-0 place-items-center", float && "loggy-float")} style={{ width: size, height: size }}>
      {mood === "listening" || mood === "speaking" ? (
        <>
          <span className="loggy-ring absolute inset-0 rounded-full bg-brand/40" />
          <span className="loggy-ring absolute inset-0 rounded-full bg-brand/30 [animation-delay:0.8s]" />
        </>
      ) : null}
      <span className="relative grid size-full place-items-center rounded-full bg-brand text-white shadow-[0_2px_8px_-2px_color-mix(in_oklch,var(--brand)_60%,transparent)]">
        <svg viewBox="0 0 32 32" width={size * 0.72} height={size * 0.72} overflow="visible">
          <rect x="5" y="9" width="22" height="15" rx="7.5" fill="currentColor" opacity="0.22" />
          {eyes}
          {mood === "speaking" ? <rect className="loggy-part loggy-talk" x="13.5" y="20.6" width="5" height="1.5" rx="0.75" fill="currentColor" /> : null}
          <path d="M16 9 V5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="16" cy="4.5" r="1.9" className={cn(lit && "loggy-bulb")} fill={lit ? "oklch(0.88 0.16 90)" : "currentColor"} />
        </svg>
      </span>
    </span>
  )
}

const QUESTION_ICON: [RegExp, LucideIcon][] = [
  [/coding|code/i, Code],
  [/limit/i, Ban],
  [/complain/i, MessageSquareWarning],
  [/not working|wrong|fail/i, TriangleAlert],
]
const iconFor = (q: string) => QUESTION_ICON.find(([re]) => re.test(q))?.[1] ?? Sparkles

function Welcome({ index, listening, onAsk }: { index: SnapshotIndex; listening: boolean; onAsk: (q: string) => void }) {
  const [hover, setHover] = useState(false)
  const rise = "animate-in fade-in-0 slide-in-from-bottom-3 fill-mode-both duration-500"
  return (
    <div className="flex flex-col items-center pt-[5vh] text-center">
      <div className={cn("relative", rise)}>
        <span aria-hidden className="loggy-glow absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--brand)_28%,transparent),transparent)]" />
        <LoggyAvatar size={76} float mood={listening ? "listening" : hover ? "happy" : "idle"} />
      </div>
      <h1 className={cn("mt-6 text-[30px] font-semibold tracking-tight", rise)} style={{ animationDelay: "80ms" }}>
        Hi, I'm Loggy.
      </h1>
      <p className={cn("mt-2 max-w-[520px] text-[15px] leading-relaxed text-pretty text-muted-foreground", rise)} style={{ animationDelay: "160ms" }}>
        Ask me what people do with your assistant and where it lets them down. I've never read one of the {fmtInt(index.snapshot.totals.conversations)} conversations. I write
        code that counts them, run it in a sealed sandbox, and only tell you what checks out.
      </p>
      <ul className="mt-9 grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-2" onMouseLeave={() => setHover(false)}>
        {EXAMPLE_QUESTIONS.map((q, i) => {
          const Icon = iconFor(q)
          return (
            <li key={q} className={rise} style={{ animationDelay: `${260 + i * 70}ms` }}>
              <button
                type="button"
                onClick={() => onAsk(q)}
                onMouseEnter={() => setHover(true)}
                className="group flex h-full w-full items-start gap-3 rounded-2xl border bg-card px-4 py-3.5 text-left text-[14px] leading-snug shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-md active:translate-y-0 active:scale-[0.99]"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6">
                  <Icon className="size-3.5" />
                </span>
                <span className="flex-1 pt-0.5">{q}</span>
                <ArrowRight className="mt-1 size-3.5 shrink-0 -translate-x-1 text-brand opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- composer

function Composer({
  active,
  busy,
  voiceReplies,
  onVoiceReplies,
  onListening,
  onAsk,
}: {
  active: boolean
  busy: boolean
  voiceReplies: boolean
  onVoiceReplies: (v: boolean) => void
  onListening: (v: boolean) => void
  onAsk: (q: string, via: Turn["via"]) => void
}) {
  const [text, setText] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dictation = useDictation((q) => {
    if (!busy) onAsk(q, "voice")
    else setText(q)
  })
  const listening = dictation.listening
  useEffect(() => {
    if (active) inputRef.current?.focus()
    else dictation.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => onListening(listening), [listening, onListening])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!text.trim() || busy) return
    onAsk(text, "text")
    setText("")
  }
  const canSend = !!text.trim() && !busy && !listening

  return (
    <form onSubmit={submit} className="mx-auto max-w-[760px]">
      <div
        className={cn(
          "relative flex items-end gap-1.5 rounded-[22px] border bg-card p-2 pl-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_30px_-14px_rgb(0_0_0/0.18)] transition-[border-color,box-shadow] duration-200",
          "focus-within:border-brand/40 focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand)_12%,transparent),0_10px_30px_-14px_rgb(0_0_0/0.18)]",
          listening && "border-brand/50 shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand)_14%,transparent),0_10px_30px_-14px_rgb(0_0_0/0.18)]",
        )}
      >
        <label htmlFor="loggy-input" className="sr-only">
          Ask Loggy
        </label>
        {listening ? (
          <div className="flex min-h-10 flex-1 animate-in items-center gap-3 py-1 duration-200 fade-in-0">
            <VoiceWave />
            <span className={cn("min-w-0 flex-1 truncate text-[15px]", dictation.interim ? "text-foreground" : "loggy-shimmer")}>{dictation.interim || "Listening…"}</span>
          </div>
        ) : (
          <textarea
            id="loggy-input"
            ref={inputRef}
            rows={1}
            maxLength={200}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
            }}
            placeholder={busy ? "Loggy is working on it…" : "Ask Loggy anything about your users"}
            className="field-sizing-content max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-snug outline-none placeholder:text-muted-foreground"
          />
        )}
        {canSpeak() && !listening ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-10 rounded-full text-muted-foreground"
            onClick={() => onVoiceReplies(!voiceReplies)}
            aria-pressed={voiceReplies}
            aria-label={voiceReplies ? "Loggy answers voice questions out loud" : "Loggy answers silently"}
            title={voiceReplies ? "Spoken replies on" : "Spoken replies off"}
          >
            {voiceReplies ? <Volume2 /> : <VolumeX />}
          </Button>
        ) : null}
        {dictation.supported ? (
          <span className="relative">
            {listening ? <span aria-hidden className="loggy-ring absolute inset-0 rounded-full bg-brand/40" /> : null}
            <Button
              type="button"
              variant={listening ? "default" : "ghost"}
              size="icon-lg"
              className={cn("relative size-10 rounded-full transition-transform active:scale-90", listening ? "bg-brand text-white hover:bg-brand/90" : "text-muted-foreground")}
              onClick={listening ? dictation.stop : dictation.start}
              disabled={busy && !listening}
              aria-label={listening ? "Stop listening" : "Ask by voice"}
            >
              {listening ? <Square className="size-3.5 fill-current" /> : <Mic />}
            </Button>
          </span>
        ) : null}
        <Button
          type="submit"
          size="icon-lg"
          className={cn("size-10 rounded-full transition-all duration-200 active:scale-90", canSend ? "scale-100 bg-brand text-white hover:bg-brand/90" : "scale-95")}
          disabled={!canSend}
          aria-label="Send"
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
      {dictation.error ? (
        <p role="alert" className="mt-2 animate-in text-center text-[12.5px] text-destructive fade-in-0">
          {dictation.error}
        </p>
      ) : null}
    </form>
  )
}

/** Bars that follow the microphone level; a gentle idle motion if the level can't be read. */
function VoiceWave() {
  const N = 22
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const [live, setLive] = useState(false)
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 64
        analyser.smoothingTimeConstant = 0.72
        ctx.createMediaStreamSource(s).connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        setLive(true)
        const tick = () => {
          analyser.getByteFrequencyData(data)
          const mid = (N - 1) / 2
          bars.current.forEach((b, i) => {
            if (!b) return
            // Loudest bands in the middle, mirrored outwards.
            const bin = 1 + Math.round(Math.abs(i - mid))
            const v = Math.min(1, (data[bin] ?? 0) / 200)
            b.style.transform = `scaleY(${0.12 + v * 0.88})`
          })
          raf = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [])
  return (
    <span aria-hidden className="flex h-7 shrink-0 items-center gap-[3px]">
      {Array.from({ length: N }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          className={cn("h-full w-[3px] rounded-full bg-brand transition-transform duration-75", !live && "loggy-wave")}
          style={live ? { transform: "scaleY(0.12)" } : { animationDelay: `${(i % 7) * 110}ms` }}
        />
      ))}
    </span>
  )
}

function Bars({ count, className, barClassName }: { count: number; className?: string; barClassName?: string }) {
  return (
    <span aria-hidden className={cn("flex items-center", className)}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cn("loggy-wave h-full rounded-full", barClassName)} style={{ animationDelay: `${i * 140}ms` }} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- one exchange

function TurnView({
  turn,
  index,
  selected,
  speaking,
  speakReply,
  onSay,
  onRun,
  onSelect,
  onAsk,
  onBuild,
}: {
  turn: Turn
  index: SnapshotIndex
  selected: boolean
  speaking: boolean
  speakReply: boolean
  onSay: (id: string, text: string) => void
  onRun: (id: string, run: Run) => void
  onSelect: () => void
  onAsk: (q: string) => void
  onBuild: (t: BuildTarget) => void
}) {
  const { run, error: pollError } = useRun(turn.runId)
  useEffect(() => {
    if (run) onRun(turn.id, run)
  }, [run, turn.id, onRun])

  const snapshotId = index.snapshot.snapshot_id
  const verified = hasVerifiedResult(run, snapshotId) && run?.result?.intent === "question"
  const unsupported = run?.state === "failed" && (run.error?.code === "unsupported_question" || run.error?.code === "interpretation_failed")
  const failed = !unsupported && (run?.state === "failed" || !!turn.error || !!pollError)
  const working = !verified && !unsupported && !failed && run?.state !== "completed"

  // A short smile when an answer checks out.
  const [happy, setHappy] = useState(false)
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && verified) {
      setHappy(true)
      const id = window.setTimeout(() => setHappy(false), 2200)
      wasWorking.current = false
      return () => window.clearTimeout(id)
    }
    wasWorking.current = working
  }, [working, verified])

  const plain = useMemo(
    () => (verified && run?.explanation ? segmentsToString(fillTemplate(run.explanation.text, run.result, index.titleOf)) : null),
    [verified, run, index.titleOf],
  )
  const spoken = useRef(false)
  useEffect(() => {
    if (!speakReply || spoken.current) return
    if (plain) {
      spoken.current = true
      onSay(turn.id, plain)
    } else if (unsupported) {
      spoken.current = true
      onSay(turn.id, "I can't answer that one from this data. Try asking about workflows, people, or friction.")
    }
  }, [plain, unsupported, speakReply, onSay, turn.id])

  const mood: Mood = speaking ? "speaking" : working ? "thinking" : happy ? "happy" : "idle"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <p className="max-w-[80%] origin-bottom-right animate-in rounded-[20px] rounded-br-md bg-foreground px-4 py-2.5 text-[15px] leading-snug text-background duration-300 fade-in-0 zoom-in-95 slide-in-from-right-3">
          {turn.via === "voice" ? <Mic aria-label="Asked by voice" className="mr-1.5 mb-0.5 inline size-3.5 opacity-70" /> : null}
          {turn.question}
        </p>
      </div>

      <div
        role="article"
        onClick={onSelect}
        className={cn(
          "group -mx-3 flex animate-in gap-3 rounded-2xl px-3 py-2 transition-colors delay-150 duration-300 fill-mode-both fade-in-0 slide-in-from-left-2 lg:cursor-pointer",
          selected ? "bg-brand-soft/50" : "lg:hover:bg-muted/40",
        )}
      >
        <LoggyAvatar size={30} mood={mood} />
        <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
          {working ? (
            <Working run={run} turn={turn} />
          ) : unsupported ? (
            <div className="flex animate-in flex-col gap-3 fade-in-0">
              <p className="text-[15px] leading-relaxed">
                I can't answer that one from this data. I count conversations or people by workflow or category, optionally with one kind of friction. Try one of these:
              </p>
              <Suggestions onAsk={onAsk} />
            </div>
          ) : failed ? (
            <p role="alert" className="animate-in text-[15px] leading-relaxed text-destructive fade-in-0">
              {turn.error?.message ?? run?.error?.message ?? pollError ?? "Something went wrong."}
            </p>
          ) : verified && run ? (
            <Answer run={run} result={run.result as QuestionResult} index={index} onBuild={(t) => onBuild({ ...t, question: turn.question })} />
          ) : (
            <p className="text-[15px] leading-relaxed text-muted-foreground">The run finished without a result I could verify, so I won't guess. Try asking again.</p>
          )}
        </div>
      </div>
    </div>
  )
}

const RAIL: { key: StepKey; label: string }[] = [
  { key: "interpreting", label: "Plan" },
  { key: "planning", label: "Write" },
  { key: "executing", label: "Run" },
  { key: "validating", label: "Check" },
  { key: "explaining", label: "Explain" },
]

/** While Loggy works: what it is doing right now, a rail of the steps, and the seconds going by. */
function Working({ run, turn }: { run: Run | null; turn: Turn }) {
  const steps = deriveSteps(run, true)
  const status = (key: StepKey): StepStatus => {
    if (key === "validating" && steps.some((s) => s.key === "repairing" && s.status === "running")) return "running"
    return steps.find((s) => s.key === key)?.status ?? "pending"
  }
  const detail = run?.stages.find((s) => s.status === "running")?.detail ?? (turn.sending ? "Reading your question…" : "Getting started…")
  const elapsed = useElapsed(turn.startedAt)
  return (
    <div role="status" aria-live="polite" className="flex max-w-[520px] animate-in flex-col gap-2.5 fade-in-0">
      <p key={detail} className="loggy-shimmer animate-in text-[15px] leading-snug duration-300 fade-in-0 slide-in-from-bottom-1">
        {detail}
      </p>
      <div className="flex items-center gap-3">
        <ol className="flex flex-1 gap-1.5" aria-label="Progress">
          {RAIL.map((r) => {
            const s = status(r.key)
            return (
              <li key={r.key} className="flex flex-1 flex-col gap-1">
                <span className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
                      s === "done" ? "w-full bg-brand" : s === "failed" ? "w-full bg-destructive" : "w-0",
                    )}
                  />
                  {s === "running" ? <span className="loggy-sweep absolute inset-0" /> : null}
                </span>
                <span className={cn("text-[11px] transition-colors", s === "running" ? "font-medium text-foreground" : s === "done" ? "text-muted-foreground" : "text-subtle")}>
                  {r.label}
                </span>
              </li>
            )
          })}
        </ol>
        <span className="w-9 self-start text-right font-mono text-[12px] text-muted-foreground tabular-nums">{elapsed}s</span>
      </div>
    </div>
  )
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  return Math.max(0, Math.floor((now - since) / 1000))
}

function Suggestions({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {EXAMPLE_QUESTIONS.map((q, i) => (
        <li key={q} className="loggy-pop" style={{ animationDelay: `${i * 60}ms` }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onAsk(q)
            }}
            className="rounded-full border bg-card px-3 py-1 text-[13px] transition-all hover:-translate-y-px hover:border-brand/30 hover:bg-brand-soft/40"
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- the answer

type Token = { kind: "word"; text: string } | { kind: "metric"; text: string } | { kind: "missing" }

function tokenize(segs: Segment[]): Token[] {
  const out: Token[] = []
  for (const s of segs) {
    if (s.kind === "text") out.push(...s.text.split(/(\s+)/).filter(Boolean).map((w): Token => ({ kind: "word", text: w })))
    else if (s.kind === "metric") out.push({ kind: "metric", text: s.text })
    else out.push({ kind: "missing" })
  }
  return out
}

/** Reveals `n` items one at a time (instantly with reduced motion). */
function useStream(n: number, msPer: number) {
  const [shown, setShown] = useState(REDUCED ? n : 0)
  useEffect(() => {
    if (shown >= n) return
    const id = window.setTimeout(() => setShown((s) => Math.min(n, s + 1)), msPer)
    return () => window.clearTimeout(id)
  }, [shown, n, msPer])
  return shown
}

function Answer({ run, result, index, onBuild }: { run: Run; result: QuestionResult; index: SnapshotIndex; onBuild: (t: Omit<BuildTarget, "question">) => void }) {
  const tokens = useMemo(
    () => (run.explanation ? tokenize(fillTemplate(run.explanation.text, run.result, index.titleOf)) : tokenize([{ kind: "text", text: "Here's what the verified numbers say:" }])),
    [run, index.titleOf],
  )
  // Whitespace tokens ride along with the word before them.
  const words = tokens.filter((t) => !(t.kind === "word" && /^\s+$/.test(t.text))).length
  const shown = useStream(words, 32)
  const textDone = shown >= words

  const byShare = result.plan.rank_by === "share"
  const rows = result.rows.slice(0, 5)
  const max = Math.max(byShare ? 0.0001 : 1, ...rows.map((r) => (byShare ? r.share : r.count)))
  const targets = buildTargets(result, index)

  const [detailId, setDetailId] = useState<string | null>(null)
  const detailNode = detailId ? index.byId.get(detailId) : undefined
  const ranking = (
        <ol className="flex animate-in flex-col gap-2.5 rounded-2xl border bg-card p-3.5 shadow-xs duration-300 fade-in-0 slide-in-from-bottom-2">
          {rows.map((r, i) => {
            const node = index.byId.get(r.id)
            const value = byShare ? r.share : r.count
            return (
              <li key={r.id} className="grid animate-in grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 fill-mode-both duration-300 fade-in-0 slide-in-from-left-1" style={{ animationDelay: `${i * 90}ms` }}>
                <span className="flex min-w-0 items-center gap-2 text-[13.5px]">
                  <Dot color={index.paletteOf(r.id).dot} />
                  <span className="truncate">{node ? proseName(node) : r.id}</span>
                </span>
                <span className="font-mono text-[12.5px] tabular-nums">
                  <CountUp value={value} format={byShare ? fmtPct : fmtInt} delay={i * 90} />
                  <span className="text-muted-foreground"> {byShare ? `of ${fmtInt(r.base)}` : `· ${fmtPct(r.share)}`}</span>
                </span>
                <GrowBar value={value / max} delay={i * 90} className={result.plan.signal ? "bg-heat/70" : "bg-brand/70"} />
              </li>
            )
          })}
        </ol>
  )

  let seen = 0
  return (
    <>
      <p className="text-[15px] leading-relaxed text-pretty">
        {tokens.map((t, i) => {
          const space = t.kind === "word" && /^\s+$/.test(t.text)
          if (!space) seen++
          if (seen > shown) return null
          if (space) return <span key={i}>{t.text}</span>
          return t.kind === "word" ? (
            <span key={i} className="animate-in duration-300 fade-in-0">
              {t.text}
            </span>
          ) : t.kind === "metric" ? (
            <span key={i} className="loggy-pop inline-block rounded-md bg-brand-soft px-1 font-semibold text-foreground tabular-nums">
              {t.text}
            </span>
          ) : (
            <span key={i} className="text-muted-foreground italic">
              unavailable
            </span>
          )
        })}
        {!textDone ? <span aria-hidden className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-brand" /> : null}
      </p>

      {textDone && rows.length ? (
        <Suspense fallback={ranking}>
          <AnswerCanvas key={`${run.run_id}:${run.snapshot_id}`} run={run} result={result} index={index} ranking={ranking} open={setDetailId} />
        </Suspense>
      ) : null}
      <Dialog open={detailId !== null} onOpenChange={(open) => { if (!open) setDetailId(null) }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle>Published workflow details</DialogTitle>
          <DialogDescription>Aggregate patterns from the same snapshot as this answer.</DialogDescription>
          <DetailPanel index={index} selectedId={detailNode?.level === 2 ? detailId : null} focusId={detailNode?.level === 1 ? detailId : null}
            onSelectLeaf={setDetailId} onFocusCategory={setDetailId} />
        </DialogContent>
      </Dialog>

      {textDone && targets.length ? (
        <div className="flex animate-in flex-col gap-2 fill-mode-both delay-500 duration-300 fade-in-0">
          <p className="text-[14.5px]">Want me to turn one of these into a user story and a prompt for your team?</p>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t, i) => (
              <span key={t.leafId} className="loggy-pop" style={{ animationDelay: `${600 + i * 90}ms` }}>
                <Button
                  variant="outline"
                  size="sm"
                  className="group h-8 rounded-full px-3 text-[13px] transition-all hover:-translate-y-px hover:border-brand/40 hover:bg-brand-soft/50 hover:text-brand"
                  onClick={(e) => {
                    e.stopPropagation()
                    onBuild(t)
                  }}
                >
                  {t.title}
                  <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
                </Button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

function GrowBar({ value, delay, className }: { value: number; delay: number; className: string }) {
  const [on, setOn] = useState(REDUCED)
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), 30 + delay)
    return () => window.clearTimeout(id)
  }, [delay])
  return (
    <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full transition-[width] duration-700 ease-out", className)} style={{ width: on ? `${Math.max(2, value * 100)}%` : "0%" }} />
    </span>
  )
}

function CountUp({ value, format, delay = 0, ms = 700 }: { value: number; format: (n: number) => string; delay?: number; ms?: number }) {
  const [v, setV] = useState(REDUCED ? value : 0)
  useEffect(() => {
    if (REDUCED) return
    let raf = 0
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now + delay
      const t = Math.max(0, Math.min(1, (now - start) / ms))
      const eased = 1 - Math.pow(1 - t, 3)
      setV(Number.isInteger(value) ? Math.round(value * eased) : value * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, delay, ms])
  return <>{format(v)}</>
}

/** Up to three workflows worth building for: leaf rows as they are, category rows by their highest-friction workflow. */
function buildTargets(result: QuestionResult, index: SnapshotIndex): Omit<BuildTarget, "question">[] {
  const out: Omit<BuildTarget, "question">[] = []
  for (const r of result.rows) {
    const node = index.byId.get(r.id)
    if (!node || node.is_other) continue
    const leaf =
      node.level === 2
        ? node
        : index
            .leavesOf(node.id)
            .filter((l) => !l.is_other)
            .sort((a, b) => b.friction.conversations - a.friction.conversations)[0]
    if (leaf && !out.some((o) => o.leafId === leaf.id)) out.push({ leafId: leaf.id, title: proseName(leaf) })
    if (out.length === 3) break
  }
  return out
}

// ---------------------------------------------------------------- under the hood

const STEP_COPY: Record<StepKey, string> = {
  interpreting: "Understands the question",
  planning: "Writes two programs",
  executing: "Runs them in a sandbox",
  validating: "Checks every output",
  repairing: "Repairs a failing program",
  explaining: "Explains the verified result",
}

const HOW = [
  { title: "Turns your question into a plan", body: "A bounded query: what to count, how to group it, which friction signal." },
  { title: "Writes two independent programs", body: "One in pandas, one in plain Python, from the data dictionary alone. It never sees a row." },
  { title: "Runs each in a throwaway sandbox", body: "A fresh container with no network, no keys and a 10 second limit." },
  { title: "Answers only if the checks pass", body: "Both outputs go through the privacy gate and must agree with each other and the published map." },
]

function UnderTheHood({ run, question, index, onOpenDetails }: { run: Run | null; question: string | null; index: SnapshotIndex; onOpenDetails: () => void }) {
  const verified = hasVerifiedResult(run, index.snapshot.snapshot_id)
  const active = isRunActive(run)
  const steps = run ? deriveSteps(run, true) : []
  const tracks = programTracks(run)
  const [program, setProgram] = useState<"A" | "B">("A")
  const track = tracks.find((t) => t.program === program) ?? tracks[0]
  const checks = run?.verdict?.checks ?? []
  const passed = checks.filter((c) => c.passed).length
  const agreement = crossChecks(run).agreement
  const receipts = tracks.flatMap((t) => (t.latest.receipt ? [t.latest.receipt] : []))
  const gvisor = receipts.length > 0 && receipts.every((r) => r.runtime === "runsc")

  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      <header>
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            {active ? (
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand" />
              </span>
            ) : null}
            Under the hood
          </h2>
          {run ? (
            verified ? (
              <span key="ok" className="loggy-pop inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[12px] font-medium text-ok">
                <Check className="size-3" />
                Verified · {fmtDuration(runDurationMs(run))}
              </span>
            ) : active ? (
              <span key="run" className="inline-flex animate-in items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-medium text-brand fade-in-0">
                <LoaderCircle className="size-3 animate-spin" />
                Working
              </span>
            ) : null
          ) : null}
        </div>
        {question ? (
          <p key={question} className="mt-1 line-clamp-2 animate-in text-[13px] text-muted-foreground fade-in-0">
            “{question}”
          </p>
        ) : null}
      </header>

      {!run ? (
        <ol className="flex flex-col gap-4">
          {HOW.map((h, i) => (
            <li key={h.title} className="group flex animate-in gap-3 fill-mode-both duration-500 fade-in-0 slide-in-from-right-2" style={{ animationDelay: `${150 + i * 90}ms` }}>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[12px] transition-colors group-hover:bg-brand group-hover:text-white">{i + 1}</span>
              <div>
                <p className="text-[13.5px] font-medium">{h.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{h.body}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <>
          {run.plan ? (
            <div className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
              <SubHead>Plan</SubHead>
              <div className="flex flex-wrap gap-1">
                {planToPhrases(run.plan, (id) => {
                  const n = index.byId.get(id)
                  return n ? proseName(n) : undefined
                }).map((p, i) => (
                  <span key={p} className="loggy-pop rounded-md bg-muted px-2 py-0.5 text-[12.5px]" style={{ animationDelay: `${i * 60}ms` }}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <SubHead>Steps</SubHead>
            <ol className="flex flex-col">
              {steps.map((s, i) => (
                <StepRow key={s.key} step={s} last={i === steps.length - 1} label={s.key === "executing" && gvisor ? "Runs them in a gVisor sandbox" : STEP_COPY[s.key]} />
              ))}
            </ol>
          </div>

          {track ? (
            <div className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
              <div className="mb-2 flex items-center justify-between">
                <SubHead className="mb-0">Code Loggy wrote</SubHead>
                {tracks.length > 1 ? (
                  <div className="relative flex rounded-md bg-muted p-0.5 text-[12px]">
                    {tracks.map((t) => (
                      <button
                        key={t.program}
                        type="button"
                        onClick={() => setProgram(t.program)}
                        aria-pressed={track.program === t.program}
                        className={cn("rounded px-2 py-0.5 transition-all duration-200", track.program === t.program ? "bg-card font-medium shadow-xs" : "text-muted-foreground hover:text-foreground")}
                      >
                        {t.program} · {PROGRAM_KIND[t.program]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <CodeReveal key={track.latest.code_sha256} code={track.latest.code} />
              {track.latest.receipt ? (
                <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                  <span className="size-1.5 rounded-full bg-ok" />
                  {track.latest.receipt.runtime === "runsc" ? "gVisor" : "runc (local)"} · {fmtMs(track.latest.receipt.elapsed_ms)} · exit {track.latest.receipt.exit_code ?? "—"} · no network ·{" "}
                  {track.latest.receipt.limits.memory_mb} MiB
                </p>
              ) : null}
            </div>
          ) : null}

          {checks.length ? (
            <div className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
              <SubHead>Checks</SubHead>
              <div className="flex items-baseline gap-2">
                <span className={cn("font-mono text-[22px] font-semibold tabular-nums", passed === checks.length ? "text-ok" : "text-destructive")}>
                  <CountUp value={passed} format={fmtInt} ms={900} />
                </span>
                <span className="text-[13.5px] text-muted-foreground">
                  of {checks.length} gate checks passed{agreement ? (agreement.passed ? " · both programs agree" : " · the programs disagree") : ""}
                </span>
              </div>
              <GrowBarBlock value={passed / checks.length} ok={passed === checks.length} />
            </div>
          ) : null}

          <Button variant="outline" size="sm" className="self-start transition-transform active:scale-95" onClick={onOpenDetails}>
            <FileCode />
            Full run details
          </Button>
        </>
      )}
    </div>
  )
}

function GrowBarBlock({ value, ok }: { value: number; ok: boolean }) {
  const [on, setOn] = useState(REDUCED)
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), 40)
    return () => window.clearTimeout(id)
  }, [])
  return (
    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full transition-[width] duration-[900ms] ease-out", ok ? "bg-ok" : "bg-destructive")} style={{ width: on ? `${value * 100}%` : "0%" }} />
    </span>
  )
}

function StepRow({ step, last, label }: { step: Step; last: boolean; label: string }) {
  const s = step.status
  return (
    <li className="relative flex gap-3 pb-3.5 last:pb-0">
      {!last ? (
        <span aria-hidden className="absolute top-5 bottom-0 left-[7.5px] w-px overflow-hidden bg-border">
          <span className={cn("block w-full bg-foreground/60 transition-[height] duration-500 ease-out", s === "done" ? "h-full" : "h-0")} />
        </span>
      ) : null}
      <StepDot status={s} />
      <div className="min-w-0">
        <p className={cn("text-[13.5px] transition-colors duration-300", s === "pending" || s === "skipped" ? "text-subtle" : s === "failed" ? "text-destructive" : s === "running" ? "font-medium" : "")}>
          {label}
        </p>
        {step.detail && s !== "pending" ? (
          <p key={step.detail} className="mt-0.5 animate-in text-[12px] leading-snug text-muted-foreground duration-300 fade-in-0 slide-in-from-top-1">
            {step.detail}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** The program appears the way it was written: a few lines at a time. */
function CodeReveal({ code }: { code: string }) {
  const lines = useMemo(() => code.split("\n"), [code])
  const [n, setN] = useState(REDUCED ? lines.length : 0)
  useEffect(() => {
    if (n >= lines.length) return
    const id = window.setTimeout(() => setN((x) => Math.min(lines.length, x + 3)), 16)
    return () => window.clearTimeout(id)
  }, [n, lines.length])
  const pre = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    const el = pre.current
    if (el && n < lines.length) el.scrollTop = el.scrollHeight
    else if (el && n >= lines.length) el.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" })
  }, [n, lines.length])
  return (
    <pre ref={pre} className="max-h-[240px] overflow-auto rounded-xl bg-foreground px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-background/90">
      <code>
        {lines.slice(0, n).join("\n")}
        {n < lines.length ? <span className="ml-px inline-block h-3 w-[6px] translate-y-0.5 animate-pulse bg-background/80" /> : null}
      </code>
    </pre>
  )
}

function SubHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("mb-2 text-[12px] font-medium text-muted-foreground", className)}>{children}</h3>
}

function StepDot({ status }: { status: StepStatus }) {
  if (status === "done")
    return (
      <span className="loggy-pop relative z-10 mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-background">
        <Check aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (status === "running")
    return (
      <span className="relative z-10 mt-0.5 grid size-4 shrink-0 place-items-center">
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
        <span className="size-1.5 animate-pulse rounded-full bg-brand" />
      </span>
    )
  if (status === "failed")
    return (
      <span className="loggy-pop relative z-10 mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-destructive text-white">
        <X aria-hidden className="size-2.5" strokeWidth={3} />
      </span>
    )
  return <span className="relative z-10 mt-0.5 size-4 shrink-0 rounded-full border border-dashed border-subtle/60 bg-card" />
}
