import { useEffect, useRef, useState } from "react"
import {
  Ban,
  Binary,
  Box,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  Globe,
  KeyRound,
  Lock,
  Map as MapIcon,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Server,
  ShieldCheck,
  Skull,
  Sparkles,
  Tags,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

// The deployed topology (docs/ARCHITECTURE.md, infra/resources.env), drawn at fixed coordinates.
// Each scenario is a list of steps; a step lights the nodes involved and sends packets along edges.

type NodeId = "browser" | "caddy" | "api" | "gate" | "pipeline" | "privdb" | "pubdb" | "glm" | "jev" | "fireworks" | "runner" | "boxA" | "boxB" | "net"
type EdgeId =
  | "browser_caddy"
  | "caddy_api"
  | "api_glm"
  | "api_runner"
  | "runner_gate"
  | "gate_api"
  | "pubdb_gate"
  | "api_pubdb"
  | "privdb_api"
  | "pipeline_glm"
  | "pipeline_jev"
  | "pipeline_fireworks"
  | "pipeline_privdb"
  | "pipeline_pubdb"
  | "runner_boxA"
  | "runner_boxB"
type Tone = "request" | "private" | "untrusted" | "verified"
type Flow = { edge: EdgeId; rev?: boolean; tone?: Tone }
type Step = {
  title: string
  stage?: string
  body: string
  crosses?: string
  withheld?: string
  note?: string
  nodes: NodeId[]
  flows: Flow[]
  blocked?: boolean
  alert?: NodeId
}
type Node = { x: number; y: number; w: number; h: number; title: string; lines: string[]; icon: LucideIcon; where: string; about: string; secrets?: string }

const W = 1240
const H = 700
const STEP_MS = 4600
const REDUCED = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const TONE: Record<Tone, string> = {
  request: "var(--brand)",
  private: "var(--warn)",
  untrusted: "var(--heat)",
  verified: "var(--ok)",
}

const NODES: Record<NodeId, Node> = {
  browser: {
    x: 30, y: 330, w: 148, h: 96, title: "Browser", lines: ["React app", "no dataset access"], icon: Monitor,
    where: "The visitor's machine",
    about: "Sends questions and reads run status. It can't submit code, and it only ever receives what the allowlist serializers release.",
    secrets: "No model or runner keys; an optional presenter token for the live intake.",
  },
  caddy: {
    x: 246, y: 340, w: 94, h: 76, title: "Caddy", lines: ["HTTPS · SPA"], icon: Lock,
    where: "App VM · public 144.202.110.2",
    about: "Terminates HTTPS for 144-202-110-2.sslip.io, serves the React build and proxies /api to FastAPI on localhost.",
  },
  api: {
    x: 428, y: 340, w: 162, h: 76, title: "FastAPI", lines: ["orchestrates every run"], icon: Server,
    where: "App VM · 127.0.0.1:8000",
    about: "Creates runs, calls the models, exports typed rows, dispatches jobs to the runner and records every stage with real timestamps.",
    secrets: "Model API keys, pseudonym salt, runner and presenter tokens.",
  },
  gate: {
    x: 614, y: 470, w: 166, h: 76, title: "Egress gate", lines: ["schema · map · A = B"], icon: ShieldCheck,
    where: "App VM · plain Python, no model",
    about: "Decides what counts as a valid result: exact schema and plan, no per-person rows, non-negative integers, count ≤ base, shares within 1e-4, published-map consistency, and identical A and B.",
  },
  pipeline: {
    x: 246, y: 236, w: 252, h: 72, title: "Pipeline", lines: ["logless rebuild · facets → map"], icon: Workflow,
    where: "App VM · offline and live intake",
    about: "Facets and friction → embeddings and discovery → classification → descriptions → privacy gate → stats → published snapshot. Aggregation never runs in the sandbox.",
  },
  privdb: {
    x: 246, y: 470, w: 138, h: 76, title: "private.db", lines: ["text · facets · rows"], icon: Database,
    where: "App VM · SQLite",
    about: "Conversations, facets, friction decisions and assignments. Only typed integer rows ever leave it, and only to the sandbox.",
  },
  pubdb: {
    x: 394, y: 470, w: 176, h: 76, title: "public.db", lines: ["snapshots · runs"], icon: Database,
    where: "App VM · SQLite",
    about: "Published snapshots and browser-safe run records. The gate cross-checks live answers against it.",
  },
  glm: {
    x: 510, y: 40, w: 274, h: 90, title: "Serverless Inference", lines: ["Vultr · GLM 5.3 (+ Flash)", "plans · writes code · explains"], icon: Sparkles,
    where: "api.vultrinference.com · HTTPS",
    about: "All LLM reasoning: facets, naming, descriptions, privacy audits, question → plan, both programs, repairs, explanations and stories.",
  },
  jev: {
    x: 368, y: 40, w: 130, h: 90, title: "TypeSafe Jev", lines: ["typed decisions"], icon: Tags,
    where: "External provider · HTTPS",
    about: "Typed friction and classification decisions, plus relevance checks on published text.",
  },
  fireworks: {
    x: 226, y: 40, w: 130, h: 90, title: "Fireworks", lines: ["embeddings"], icon: Binary,
    where: "External provider · HTTPS",
    about: "qwen3-embedding-8b over generalized facet sentences only. The vectors come back to discovery on the app VM.",
  },
  runner: {
    x: 866, y: 340, w: 180, h: 76, title: "Runner :8787", lines: ["2 workers · queue of 16"], icon: Cpu,
    where: "Sandbox VM · 10.20.0.4, VPC only",
    about: "Accepts jobs from the app VM's private IP only, runs each program in a fresh container, kills it at the deadline and verifies removal. If removal can't be verified it quarantines itself.",
    secrets: "Only RUNNER_TOKEN. No model keys, no cloud credentials.",
  },
  boxA: {
    x: 866, y: 470, w: 158, h: 116, title: "gVisor A", lines: ["program A · pandas", "fresh container", "destroyed after"], icon: Box,
    where: "Sandbox VM · docker --runtime=runsc",
    about: "--network=none, read-only root and inputs, non-root, all capabilities dropped, no-new-privileges. 1 vCPU, 512 MiB, 64 pids, 10 s.",
    secrets: "None. Typed integer rows only, no text.",
  },
  boxB: {
    x: 1040, y: 470, w: 148, h: 116, title: "gVisor B", lines: ["program B · stdlib", "fresh container", "destroyed after"], icon: Box,
    where: "Sandbox VM · docker --runtime=runsc",
    about: "Same limits as A, written independently in plain Python. Both must produce the same canonical result.",
    secrets: "None. Typed integer rows only, no text.",
  },
  net: {
    x: 866, y: 40, w: 338, h: 90, title: "Internet · cloud metadata", lines: ["and the app VM", "no route from any container"], icon: Globe,
    where: "Outside the sandbox",
    about: "Containers get no network at all. The sandbox host's own egress is locked to the VPC by a firewall.",
  },
}

const EDGES: Record<EdgeId, string> = {
  browser_caddy: "M 178 378 L 246 378",
  caddy_api: "M 340 378 L 428 378",
  api_glm: "M 560 340 C 560 250, 640 230, 640 130",
  api_runner: "M 590 378 L 866 378",
  runner_gate: "M 866 400 C 820 400, 830 508, 780 508",
  gate_api: "M 690 470 C 690 430, 630 404, 590 404",
  pubdb_gate: "M 570 508 L 614 508",
  api_pubdb: "M 510 416 L 510 470",
  privdb_api: "M 320 470 C 320 440, 450 446, 450 416",
  pipeline_glm: "M 470 236 C 470 190, 540 175, 540 130",
  pipeline_jev: "M 433 236 L 433 130",
  pipeline_fireworks: "M 291 236 L 291 130",
  pipeline_privdb: "M 364 308 L 364 470",
  pipeline_pubdb: "M 404 308 L 404 470",
  runner_boxA: "M 945 416 L 945 470",
  runner_boxB: "M 1030 416 C 1030 445, 1100 445, 1100 470",
}
const BLOCKED = { d: "M 1160 470 L 1160 130", x: 1160, y: 300 }

type ScenarioId = "ask" | "map" | "contain"
const SCENARIOS: { id: ScenarioId; label: string; icon: LucideIcon; blurb: string; steps: Step[] }[] = [
  {
    id: "ask",
    label: "Ask Loggy",
    icon: MessageSquare,
    blurb: "What happens between a question and a verified answer.",
    steps: [
      {
        title: "You ask Loggy",
        body: "The question goes over HTTPS to Caddy, which hands it to FastAPI (POST /api/analyses). The API opens a run; the browser polls GET /api/runs/{id} and draws each stage as it lands.",
        crosses: "Question text (≤ 200 characters) and the snapshot id",
        withheld: "The browser can't send code and never touches the dataset",
        nodes: ["browser", "caddy", "api"],
        flows: [{ edge: "browser_caddy" }, { edge: "caddy_api" }],
      },
      {
        title: "Interpret and plan",
        stage: "interpreting · planning",
        body: "GLM 5.3 on Vultr Serverless Inference turns the question into a bounded plan, validated against a schema. A request the plan can't express is refused here, before any code exists.",
        crosses: "Question + data dictionary (columns and types)",
        withheld: "Rows, conversation text, private ids",
        nodes: ["api", "glm"],
        flows: [{ edge: "api_glm" }, { edge: "api_glm", rev: true, tone: "untrusted" }],
      },
      {
        title: "Two programs, written apart",
        stage: "planning",
        body: "Two independent calls: program A in pandas, program B in plain Python. Neither sees a single row, and both have to arrive at the same answer.",
        crosses: "Plan, output contract and data dictionary",
        withheld: "Any data at all",
        nodes: ["api", "glm"],
        flows: [{ edge: "api_glm" }, { edge: "api_glm", rev: true, tone: "untrusted" }, { edge: "api_glm", rev: true, tone: "untrusted" }],
      },
      {
        title: "Export typed rows",
        body: "The app VM exports only what the programs need: randomized integer pseudonyms, public workflow ids and tri-state friction. Pseudonyms are re-drawn for every export.",
        crosses: "assignments.csv · clusters.json · contract.json",
        withheld: "Conversation text, facets, titles, real user and conversation ids",
        nodes: ["privdb", "api"],
        flows: [{ edge: "privdb_api", tone: "private" }],
      },
      {
        title: "Dispatch over the VPC",
        stage: "executing",
        body: "Code and inputs go to the runner on the sandbox VM over the private Vultr VPC with a bearer token. The runner listens on 10.20.0.4:8787 and its firewall admits only the app VM.",
        crosses: "Two programs (≤ 64 KiB each) and typed inputs (≤ 8 MiB)",
        withheld: "Model keys, cloud credentials, the pseudonym salt",
        nodes: ["api", "runner"],
        flows: [{ edge: "api_runner" }, { edge: "api_runner", tone: "private" }],
      },
      {
        title: "Run each in its own gVisor box",
        stage: "executing",
        body: "Each program gets a fresh container under runsc (gVisor): no network, read-only root, non-root, every capability dropped. The supervisor kills it from outside at the deadline.",
        crosses: "--network=none · 1 vCPU · 512 MiB · 64 pids · 10 s",
        withheld: "Any way out: internet, cloud metadata and the app VM are unreachable",
        nodes: ["runner", "boxA", "boxB", "net"],
        flows: [{ edge: "runner_boxA" }, { edge: "runner_boxB" }],
        blocked: true,
      },
      {
        title: "Destroy, then return",
        body: "A job only finishes once its container is removed and the removal is verified. The result travels back as untrusted JSON; the runner's framing is transport, not trust.",
        crosses: "result.json (≤ 1 MiB) and a receipt: exit code, runtime, elapsed, image",
        withheld: "stderr stays on the backend, away from the browser and every prompt",
        nodes: ["boxA", "boxB", "runner", "gate"],
        flows: [
          { edge: "runner_boxA", rev: true, tone: "untrusted" },
          { edge: "runner_boxB", rev: true, tone: "untrusted" },
          { edge: "runner_gate", tone: "untrusted" },
        ],
      },
      {
        title: "Egress gate",
        stage: "validating",
        body: "Plain code checks each output: exact schema, no per-person rows, non-negative integers, count ≤ base, shares within 1e-4. It cross-checks the published map and requires A and B to agree.",
        crosses: "Published map totals from public.db",
        note: "A failed check buys one repair round. GLM gets the check names only, never values or stderr. A second failure means no answer.",
        nodes: ["gate", "pubdb"],
        flows: [{ edge: "pubdb_gate", tone: "verified" }],
      },
      {
        title: "Explain with placeholders",
        stage: "explaining",
        body: "GLM writes the explanation around placeholders like {share_1}. It can't write a number: the browser fills every figure from the verified sandbox result.",
        crosses: "The verified aggregate and the plan",
        withheld: "Raw sandbox output",
        nodes: ["gate", "api", "glm"],
        flows: [{ edge: "gate_api", tone: "verified" }, { edge: "api_glm" }, { edge: "api_glm", rev: true, tone: "untrusted" }],
      },
      {
        title: "Verified answer",
        body: "The run is saved to public.db and the browser gets the answer, both programs, their receipts and every check.",
        crosses: "Aggregates, checked prose, code, sanitized receipts",
        withheld: "Conversation text, facets, private ids (allowlist serializers)",
        nodes: ["api", "pubdb", "caddy", "browser"],
        flows: [
          { edge: "api_pubdb", tone: "verified" },
          { edge: "caddy_api", rev: true, tone: "verified" },
          { edge: "browser_caddy", rev: true, tone: "verified" },
        ],
      },
    ],
  },
  {
    id: "map",
    label: "Build the map",
    icon: MapIcon,
    blurb: "How raw conversations become the published map, on the app VM.",
    steps: [
      {
        title: "Conversations land",
        body: "logless rebuild reads conversations from private.db: 5,000 WildChat conversations, or any chat log through the validated JSONL importer.",
        crosses: "Raw conversation text, which stays on the app VM",
        nodes: ["privdb", "pipeline"],
        flows: [{ edge: "pipeline_privdb", rev: true, tone: "private" }],
      },
      {
        title: "Facets and friction",
        body: "GLM (Flash for facets) summarizes each conversation into generalized facets. TypeSafe Jev makes the typed friction decisions.",
        crosses: "Raw text, over HTTPS to the model providers",
        note: "Model providers see raw text outside the VPC. That's a stated limit, not a hidden one.",
        nodes: ["pipeline", "glm", "jev"],
        flows: [{ edge: "pipeline_glm", tone: "private" }, { edge: "pipeline_jev", tone: "private" }],
      },
      {
        title: "Embed and discover",
        body: "Fireworks embeds the generalized facet sentences; discovery clusters the vectors on the app VM, with leftover rounds and a hierarchy.",
        crosses: "Generalized facet sentences only",
        withheld: "Raw conversation text",
        nodes: ["pipeline", "fireworks"],
        flows: [{ edge: "pipeline_fireworks" }, { edge: "pipeline_fireworks", rev: true, tone: "untrusted" }],
      },
      {
        title: "Classify, name, describe",
        body: "Every conversation is assigned to a workflow; GLM names and describes each cluster from facets, and Jev checks the typed decisions.",
        crosses: "Facets and cluster samples",
        nodes: ["pipeline", "glm", "jev"],
        flows: [{ edge: "pipeline_glm" }, { edge: "pipeline_jev" }],
      },
      {
        title: "Privacy gate",
        body: "Every published title and description is audited before release. Anything that fails is withheld.",
        crosses: "Candidate published text",
        nodes: ["pipeline", "glm"],
        flows: [{ edge: "pipeline_glm" }, { edge: "pipeline_glm", rev: true, tone: "untrusted" }],
      },
      {
        title: "Publish the snapshot",
        body: "Trusted pipeline code computes counts, distinct people, friction and languages, then publishes atomically. No aggregation runs in the sandbox.",
        crosses: "Aggregates, titles, descriptions",
        withheld: "Conversation text and facets",
        nodes: ["pipeline", "pubdb"],
        flows: [{ edge: "pipeline_pubdb", tone: "verified" }],
      },
      {
        title: "The map reaches the browser",
        body: "GET /api/snapshot serves the published aggregates. The Dataset tab draws them, and Loggy's gate cross-checks against the same snapshot.",
        withheld: "Anything from private.db",
        nodes: ["pubdb", "api", "caddy", "browser"],
        flows: [
          { edge: "api_pubdb", rev: true, tone: "verified" },
          { edge: "caddy_api", rev: true, tone: "verified" },
          { edge: "browser_caddy", rev: true, tone: "verified" },
        ],
      },
    ],
  },
  {
    id: "contain",
    label: "Hostile code",
    icon: Skull,
    blurb: "The containment check: what a rogue program can and can't do.",
    steps: [
      {
        title: "Start the containment check",
        body: "POST /api/demo/containment accepts no code. Every program is a fixed, reviewed fixture from backend/sandbox_tasks/.",
        nodes: ["browser", "caddy", "api"],
        flows: [{ edge: "browser_caddy" }, { edge: "caddy_api" }],
      },
      {
        title: "Runaway loop",
        stage: "runaway",
        body: "An infinite loop with a 2 s deadline. The supervisor sends SIGKILL from outside the container; the program gets no say.",
        nodes: ["api", "runner", "boxA"],
        flows: [{ edge: "api_runner" }, { edge: "runner_boxA", tone: "untrusted" }],
        alert: "boxA",
      },
      {
        title: "Cleanup verified",
        stage: "cleanup · health",
        body: "The runner asks docker for any container with the job's label. None may remain; if one does, the runner quarantines itself and refuses new jobs. The API's health check still reports ok.",
        nodes: ["runner", "boxA", "api"],
        flows: [{ edge: "runner_boxA", rev: true, tone: "verified" }],
      },
      {
        title: "rm -rf --no-preserve-root /",
        stage: "destructive",
        body: "Runs in a fresh read-only container under gVisor. About 11,000 removals are refused; the host and the next run are untouched.",
        nodes: ["runner", "boxB"],
        flows: [{ edge: "runner_boxB", tone: "untrusted" }],
        alert: "boxB",
      },
      {
        title: "Follow-up run",
        stage: "followup",
        body: "A benign program then runs from the same pinned image and passes the gate, including the cross-check against the published map. The sandbox is still clean.",
        nodes: ["runner", "boxA", "gate", "pubdb"],
        flows: [{ edge: "runner_boxA", rev: true, tone: "verified" }, { edge: "runner_gate", tone: "verified" }, { edge: "pubdb_gate", tone: "verified" }],
      },
      {
        title: "Leak attempt",
        stage: "leak_attempt",
        body: "A program tries to publish per-user friction rows. It runs to completion, and the egress gate rejects its output, so nothing leaves.",
        nodes: ["runner", "boxB", "gate"],
        flows: [{ edge: "runner_boxB", rev: true, tone: "untrusted" }, { edge: "runner_gate", tone: "untrusted" }],
        alert: "gate",
      },
      {
        title: "No way out",
        body: "Containers have no network, so the internet, cloud metadata and the app VM are unreachable, and nothing secret was ever mounted. The full hostile battery is in docs/SECURITY.md.",
        withheld: "Secrets, network, host filesystem",
        nodes: ["boxA", "boxB", "net"],
        flows: [],
        blocked: true,
      },
    ],
  },
]

export function ArchitectureTab({ active }: { active: boolean }) {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("ask")
  const [stepIndex, setStepIndex] = useState(0)
  const [playing, setPlaying] = useState(!REDUCED)
  const [picked, setPicked] = useState<NodeId | null>(null)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!
  const step = scenario.steps[stepIndex]
  const last = stepIndex === scenario.steps.length - 1

  const choose = (id: ScenarioId) => {
    setScenarioId(id)
    setStepIndex(0)
    setPlaying(!REDUCED)
  }
  const go = (i: number) => {
    setStepIndex(Math.max(0, Math.min(scenario.steps.length - 1, i)))
    setPlaying(false)
  }
  // The progress bar's own animation drives autoplay, so pausing holds it exactly where it is.
  const advance = () => (last ? setPlaying(false) : setStepIndex((i) => i + 1))

  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "nearest" })
  }, [stepIndex, scenarioId])

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_400px] lg:overflow-hidden">
      <section aria-label="Architecture diagram" className="relative min-h-0 px-4 py-4 sm:px-6 lg:overflow-y-auto">
        <div className="mx-auto w-full max-w-[1240px]">
          <Diagram step={step} stepKey={`${scenarioId}-${stepIndex}`} picked={picked} onPick={(id) => setPicked((p) => (p === id ? null : id))} />
          <Legend />
        </div>
        {picked ? <NodeCard id={picked} onClose={() => setPicked(null)} /> : null}
      </section>

      <aside aria-label="Walkthrough" className="flex min-h-0 flex-col border-t bg-card lg:border-t-0 lg:border-l">
        <div className="shrink-0 border-b px-5 pt-5 pb-4">
          <h1 className="text-[17px] font-semibold tracking-tight">How logless is wired</h1>
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
            Two Vultr VMs on a private VPC. Agent code only ever runs in throwaway gVisor containers on the sandbox VM.
          </p>
          <div role="tablist" aria-label="Scenario" className="mt-4 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === scenarioId}
                onClick={() => choose(s.id)}
                className={cn(
                  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition-colors",
                  s.id === scenarioId ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <s.icon aria-hidden className="size-3.5" />
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-[12.5px] text-muted-foreground">{scenario.blurb}</p>
        </div>

        <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {scenario.steps.map((s, i) => {
            const current = i === stepIndex
            return (
              <li key={s.title} data-current={current || undefined}>
                <button
                  onClick={() => go(i)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "relative flex w-full items-start gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors",
                    current ? "bg-brand-soft/60" : "hover:bg-muted",
                  )}
                >
                  {current && !REDUCED ? (
                    <span
                      key={`${scenarioId}-${i}`}
                      aria-hidden
                      onAnimationEnd={advance}
                      className="arch-progress absolute inset-x-0 top-0 h-0.5 bg-brand"
                      style={{ animationDuration: `${STEP_MS}ms`, animationPlayState: playing && active ? "running" : "paused" }}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "mt-px grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10.5px] tabular-nums",
                      current ? "bg-brand text-brand-foreground" : i < stepIndex ? "bg-muted text-foreground" : "bg-muted text-subtle",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className={cn("text-[13.5px] font-medium", !current && "text-muted-foreground")}>{s.title}</span>
                      {s.stage ? <span className="font-mono text-[10.5px] text-subtle">{s.stage}</span> : null}
                    </span>
                    {current ? <StepDetail step={s} /> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="flex shrink-0 items-center gap-1.5 border-t px-4 py-3">
          <Button size="icon" variant="ghost" aria-label="Previous step" disabled={stepIndex === 0} onClick={() => go(stepIndex - 1)}>
            <ChevronLeft />
          </Button>
          {REDUCED ? null : last && !playing ? (
            <Button size="sm" variant="outline" onClick={() => { setStepIndex(0); setPlaying(true) }}>
              <RotateCcw />
              Replay
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause /> : <Play />}
              {playing ? "Pause" : "Play"}
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label="Next step" disabled={last} onClick={() => go(stepIndex + 1)}>
            <ChevronRight />
          </Button>
          <span className="ml-auto font-mono text-[11.5px] text-subtle tabular-nums">
            {stepIndex + 1} / {scenario.steps.length}
          </span>
        </div>
      </aside>
    </div>
  )
}

function StepDetail({ step }: { step: Step }) {
  return (
    <span className="mt-1.5 block space-y-2 text-[12.5px] leading-snug">
      <span className="block text-pretty text-foreground/85">{step.body}</span>
      {step.crosses ? (
        <span className="flex gap-2">
          <span className="w-[68px] shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Crosses</span>
          <span className="text-foreground/85">{step.crosses}</span>
        </span>
      ) : null}
      {step.withheld ? (
        <span className="flex gap-2">
          <span className="w-[68px] shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Never</span>
          <span className="flex gap-1.5 text-foreground/85">
            <Ban aria-hidden className="mt-0.5 size-3 shrink-0 text-destructive" />
            {step.withheld}
          </span>
        </span>
      ) : null}
      {step.note ? <span className="block rounded-md bg-warn-soft px-2.5 py-1.5 text-foreground/85">{step.note}</span> : null}
    </span>
  )
}

function Diagram({ step, stepKey, picked, onPick }: { step: Step; stepKey: string; picked: NodeId | null; onPick: (id: NodeId) => void }) {
  const lit = new Set<NodeId>(step.nodes)
  const flows = new Map<EdgeId, Flow>()
  for (const f of step.flows) if (!flows.has(f.edge)) flows.set(f.edge, f)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none" role="img" aria-label="logless architecture: browser, app VM, sandbox VM, model providers">
      <Zone x={16} y={170} w={176} h={516} label="VISITOR" dashed />
      <Zone x={210} y={12} w={590} h={136} label="MODEL PROVIDERS · HTTPS · OUTSIDE THE VPC" dashed fill="color-mix(in oklch, var(--muted) 70%, transparent)" />
      <Zone x={846} y={12} w={378} h={136} label="PUBLIC NETWORK" dashed fill="color-mix(in oklch, var(--destructive) 4%, transparent)" stroke="color-mix(in oklch, var(--destructive) 35%, transparent)" />
      <Zone x={210} y={170} w={1014} h={516} label="VULTR VPC · 10.20.0.0/24 · SJC" dashed fill="color-mix(in oklch, var(--brand) 3.5%, transparent)" stroke="color-mix(in oklch, var(--brand) 35%, transparent)" />
      <Zone x={226} y={200} w={574} h={470} label="APP VM · 10.20.0.3" fill="color-mix(in oklch, var(--muted) 55%, var(--card))" />
      <Zone x={846} y={200} w={362} h={470} label="SANDBOX VM · 10.20.0.4" fill="color-mix(in oklch, var(--muted) 55%, var(--card))" />

      <Footnote x={246} y={640} icon={KeyRound} text="Holds model API keys · pseudonym salt · runner token · private data" />
      <text x={866} y={614} style={{ fill: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }} fontSize={10.5}>
        runsc · --network=none · read-only root
      </text>
      <text x={866} y={631} style={{ fill: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }} fontSize={10.5}>
        1 vCPU · 512 MiB · 64 pids · 10 s
      </text>
      <Footnote x={866} y={656} icon={KeyRound} text="Runner token only · no API or cloud keys" />

      {(Object.keys(EDGES) as EdgeId[]).map((id) => {
        const f = flows.get(id)
        return (
          <path
            key={id}
            d={EDGES[id]}
            fill="none"
            className={cn("arch-edge", f && (f.rev ? "arch-dash-rev" : "arch-dash"))}
            style={{ stroke: f ? TONE[f.tone ?? "request"] : "var(--subtle)", strokeOpacity: f ? 1 : 0.4, strokeWidth: f ? 2 : 1.25 }}
          />
        )
      })}
      <path
        d={BLOCKED.d}
        fill="none"
        strokeDasharray="3 5"
        className="arch-edge"
        style={{ stroke: "var(--destructive)", strokeOpacity: step.blocked ? 0.9 : 0.3, strokeWidth: step.blocked ? 2 : 1.25 }}
      />
      <g transform={`translate(${BLOCKED.x} ${BLOCKED.y})`} className="arch-edge" opacity={step.blocked ? 1 : 0.45}>
        <circle r={11} style={{ fill: "var(--card)", stroke: "var(--destructive)" }} strokeWidth={1.5} />
        <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" style={{ stroke: "var(--destructive)" }} strokeWidth={2} strokeLinecap="round" />
      </g>

      <EdgeLabel x={212} y={366} text="HTTPS" />
      <EdgeLabel x={728} y={366} text="VPC · bearer" />
      <EdgeLabel x={1114} y={276} text="no route" anchor="end" />

      {(Object.keys(NODES) as NodeId[]).map((id) => (
        <NodeBox key={id} id={id} lit={lit.has(id)} alert={step.alert === id} picked={picked === id} onPick={onPick} />
      ))}

      {/* Keyed by step so packets restart in phase whenever the step changes. */}
      {REDUCED ? null : (
        <g key={stepKey} pointerEvents="none">
          {step.flows.map((f, i) =>
            [0, 1].map((k) => (
              <circle key={`${i}-${k}`} r={4.5} style={{ fill: TONE[f.tone ?? "request"] }} opacity={0}>
                <set attributeName="opacity" to="1" begin={`${0.35 * i + 0.7 * k}s`} />
                <animateMotion
                  dur="1.4s"
                  begin={`${0.35 * i + 0.7 * k}s`}
                  repeatCount="indefinite"
                  path={EDGES[f.edge]}
                  keyPoints={f.rev ? "1;0" : "0;1"}
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
            )),
          )}
        </g>
      )}
    </svg>
  )
}

function Zone({ x, y, w, h, label, dashed, fill, stroke }: { x: number; y: number; w: number; h: number; label: string; dashed?: boolean; fill?: string; stroke?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} strokeDasharray={dashed ? "5 5" : undefined} style={{ fill: fill ?? "transparent", stroke: stroke ?? "var(--border)" }} strokeWidth={1.25} />
      <text x={x + 16} y={y + 20} fontSize={10.5} letterSpacing="0.08em" style={{ fill: "var(--subtle)", fontFamily: "var(--font-mono)" }}>
        {label}
      </text>
    </g>
  )
}

function Footnote({ x, y, icon: Icon, text }: { x: number; y: number; icon: LucideIcon; text: string }) {
  return (
    <g>
      <Icon x={x} y={y - 11} width={13} height={13} color="var(--warn)" />
      <text x={x + 19} y={y} fontSize={11.5} style={{ fill: "var(--muted-foreground)" }}>
        {text}
      </text>
    </g>
  )
}

function EdgeLabel({ x, y, text, anchor = "middle" }: { x: number; y: number; text: string; anchor?: "middle" | "end" }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={10} style={{ fill: "var(--subtle)", fontFamily: "var(--font-mono)" }}>
      {text}
    </text>
  )
}

function NodeBox({ id, lit, alert, picked, onPick }: { id: NodeId; lit: boolean; alert: boolean; picked: boolean; onPick: (id: NodeId) => void }) {
  const n = NODES[id]
  const Icon = n.icon
  const edge = alert ? "var(--destructive)" : lit ? "var(--brand)" : picked ? "var(--foreground)" : "var(--border)"
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${n.title}: details`}
      aria-pressed={picked}
      className="arch-node map-anim"
      opacity={lit || picked ? 1 : 0.62}
      onClick={() => onPick(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onPick(id)
        }
      }}
    >
      <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={13} className="focus-ring" fill="none" style={{ stroke: "var(--ring)" }} strokeWidth={2} />
      <rect
        x={n.x}
        y={n.y}
        width={n.w}
        height={n.h}
        rx={10}
        className="map-anim"
        style={{ fill: alert ? "color-mix(in oklch, var(--destructive) 8%, var(--card))" : lit ? "color-mix(in oklch, var(--brand-soft) 70%, var(--card))" : "var(--card)", stroke: edge }}
        strokeWidth={lit || alert || picked ? 1.75 : 1}
      />
      <Icon x={n.x + 12} y={n.y + 13} width={16} height={16} color={alert ? "var(--destructive)" : lit ? "var(--brand)" : "var(--muted-foreground)"} />
      <text x={n.x + 35} y={n.y + 26} fontSize={13.5} fontWeight={600} style={{ fill: "var(--foreground)" }}>
        {n.title}
      </text>
      {id === "api" || id === "runner" ? <KeyRound x={n.x + n.w - 24} y={n.y + 14} width={12} height={12} color="var(--warn)" /> : null}
      {n.lines.map((line, i) => (
        <text key={line} x={n.x + 12} y={n.y + 48 + i * 17} fontSize={11.5} style={{ fill: "var(--muted-foreground)" }}>
          {line}
        </text>
      ))}
    </g>
  )
}

function Legend() {
  const items: [string, string, boolean?][] = [
    ["Request", TONE.request],
    ["Private rows, no text", TONE.private],
    ["Untrusted output", TONE.untrusted],
    ["Verified", TONE.verified],
    ["Blocked", "var(--destructive)", true],
  ]
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-muted-foreground">
      {items.map(([label, color, dashed]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("h-0 w-4 border-t-2", dashed && "border-dashed")} style={{ borderColor: color }} />
          {label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <KeyRound aria-hidden className="size-3 text-warn" />
        Holds a secret
      </li>
      <li className="ml-auto text-subtle">Click any box for details</li>
    </ul>
  )
}

function NodeCard({ id, onClose }: { id: NodeId; onClose: () => void }) {
  const n = NODES[id]
  const Icon = n.icon
  return (
    <section aria-label={`${n.title} details`} className="absolute bottom-4 left-4 z-10 w-[min(360px,calc(100%-2rem))] rounded-xl border bg-card p-4 shadow-lg sm:left-6">
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-4 text-brand" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{n.title}</h2>
          <p className="font-mono text-[11px] text-subtle">{n.where}</p>
        </div>
        <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-snug text-pretty text-foreground/85">{n.about}</p>
      {n.secrets ? (
        <p className="mt-2 flex gap-1.5 text-[12.5px] leading-snug text-muted-foreground">
          <KeyRound aria-hidden className="mt-0.5 size-3 shrink-0 text-warn" />
          {n.secrets}
        </p>
      ) : null}
    </section>
  )
}
