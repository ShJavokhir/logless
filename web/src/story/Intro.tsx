import { ArrowRight, Box, Cpu, Globe, KeyRound, Lock, Server, ShieldCheck } from "lucide-react"
import type { SnapshotIndex } from "@/lib/snapshot"
import { fmtInt } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const PLAN = [
  { n: 1, title: "Organize", body: "Private transcripts become summaries, embeddings, clusters and a two-level hierarchy of workflows.", tech: "GLM 5.3 · qwen3 embeddings · k-means · Jev" },
  { n: 2, title: "Ask", body: "An agent answers product questions by writing two programs and running them in throwaway gVisor containers.", tech: "Vultr sandbox VM · runsc · egress gate" },
  { n: 3, title: "Build", body: "Findings become a ranked roadmap and PRDs whose every number comes from verified metrics.", tech: "published metrics only" },
]

export function Intro({ index, onStart }: { index: SnapshotIndex; onStart: () => void }) {
  const d = index.snapshot.dataset
  const fixtures = (d.fixtures.canary_conversations ?? 0) + (d.fixtures.injection_conversations ?? 0)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)] lg:items-center lg:gap-14 lg:py-14">
        <div>
          <p className="text-[12.5px] font-medium tracking-wide text-brand uppercase">Clio-style usage insights, run on Vultr</p>
          <h1 className="mt-3 text-[clamp(30px,4vw,46px)] leading-[1.08] font-semibold tracking-[-0.025em] text-balance">
            What do people use your assistant for, and where does it fail them?
          </h1>
          <p className="mt-5 max-w-[560px] text-[16px] leading-relaxed text-pretty text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{fmtInt(d.conversations - fixtures)}</span> real conversations from{" "}
            <span className="font-medium text-foreground tabular-nums">{fmtInt(d.users)}</span> people in{" "}
            <span className="font-medium text-foreground tabular-nums">{d.languages}</span> languages. Nobody on the product team gets to read them. logless
            answers anyway: every number is computed by code, every answer by a sandboxed agent, and only aggregates reach the browser.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={onStart}>
              Start with one conversation
              <ArrowRight />
            </Button>
            <span className="text-[12.5px] text-muted-foreground">
              Idea: Anthropic's Clio (2024). Data: {d.name}, {d.license}.
              {fixtures ? ` The map also holds ${fixtures} planted test fixtures.` : ""}
            </span>
          </div>

          <ol className="mt-10 grid gap-3 sm:grid-cols-3">
            {PLAN.map((p) => (
              <li key={p.n} className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                  <span className="grid size-5 place-items-center rounded-full bg-foreground font-mono text-[11px] text-background">{p.n}</span>
                  {p.title}
                </div>
                <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">{p.body}</p>
                <p className="mt-2 font-mono text-[10.5px] leading-snug text-subtle">{p.tech}</p>
              </li>
            ))}
          </ol>
        </div>

        <Architecture />
      </div>
    </div>
  )
}

export function Architecture() {
  return (
    <figure aria-label="Architecture" className="rounded-2xl border bg-card p-5 shadow-xs">
      <figcaption className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">Where everything runs</span>
        <span className="font-mono text-[11px]">2 Vultr VMs · 1 VPC</span>
      </figcaption>

      <div className="mt-4 flex flex-col items-stretch gap-2">
        <Node icon={Globe} title="Browser" tone="muted" lines={["published aggregates only", "no transcript route exists"]} />
        <Link label="HTTPS" />
        <Node
          icon={Server}
          title="App VM · control plane"
          lines={["FastAPI · pipeline · SQLite", "plans, dispatches, gates every output"]}
          badge={<Badge icon={KeyRound}>holds the API keys</Badge>}
        />
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-2">
            <Link label="HTTPS" />
            <Node icon={Cpu} title="Vultr Serverless Inference" tone="brand" lines={["GLM 5.3: every agent step", "plan, code, repair, explain"]} />
            <p className="px-1 text-[10.5px] leading-snug text-subtle">
              Other model APIs, pipeline only: TypeSafe Jev (typed decisions), Fireworks (embeddings, build only)
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Link label="VPC only · bearer token" />
            <Node
              icon={Server}
              title="Sandbox VM"
              lines={["runner · Docker + gVisor", "egress locked to the VPC"]}
              badge={<Badge icon={Lock}>no API keys</Badge>}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div />
          <div className="flex flex-col gap-2">
            <Link label="one per program" />
            <div className="rounded-xl border border-dashed border-foreground/25 bg-muted/40 p-3">
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                <Box aria-hidden className="size-3.5" />
                gVisor container
              </div>
              <ul className="mt-1.5 grid gap-0.5 font-mono text-[10.5px] leading-snug text-muted-foreground">
                <li>--runtime=runsc</li>
                <li>--network=none --read-only</li>
                <li>--cap-drop=ALL · 64 pids</li>
                <li>512 MiB · 1 CPU · 10 s deadline</li>
                <li>destroyed after every run</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-4 flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0 text-ok" />
        The agent's code never runs in the app process, never sees a key, and can't reach the network. Its output is only data until the gate accepts it.
      </p>
    </figure>
  )
}

function Node({
  icon: Icon,
  title,
  lines,
  badge,
  tone = "default",
}: {
  icon: typeof Globe
  title: string
  lines: string[]
  badge?: React.ReactNode
  tone?: "default" | "muted" | "brand"
}) {
  return (
    <div className={cn("rounded-xl border p-3", tone === "muted" && "bg-muted/40", tone === "brand" && "border-brand/25 bg-brand-soft")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          <Icon aria-hidden className="size-3.5" />
          {title}
        </span>
        {badge}
      </div>
      <ul className="mt-1 grid gap-0.5 text-[11.5px] leading-snug text-muted-foreground">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  )
}

function Badge({ icon: Icon, children }: { icon: typeof Globe; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-card px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">
      <Icon aria-hidden className="size-3" />
      {children}
    </span>
  )
}

function Link({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pl-4 text-[10.5px] text-subtle">
      <span className="h-4 w-px bg-foreground/25" />
      <span className="font-mono">{label}</span>
    </div>
  )
}
