import type { ReactNode } from "react"
import { Ban, CircleDashed, MessageSquareWarning, PencilLine, Repeat2, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Signal } from "@/lib/types"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const SIGNAL_ICON: Record<Signal, LucideIcon> = {
  correction: PencilLine,
  repeat_request: Repeat2,
  assistant_limit: Ban,
  complaint: MessageSquareWarning,
}

export function SignalIcon({ signal, className }: { signal: Signal | null; className?: string }) {
  const Icon = signal ? SIGNAL_ICON[signal] : CircleDashed
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
}

/** Public evidence id (n1, p2 …) as a tiny mono tag. */
export function EvidenceTag({
  id,
  active,
  className,
  ...rest
}: { id: string; active?: boolean; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded-[4px] border px-1 font-mono text-[10px] leading-none tracking-tight text-muted-foreground tabular-nums transition-colors",
        active ? "border-brand/40 bg-brand-soft text-brand" : "border-border bg-muted/60",
        className,
      )}
      {...rest}
    >
      {id}
    </span>
  )
}

export function SectionLabel({ children, className, aside }: { children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <div className={cn("mb-2 flex items-baseline justify-between gap-3", className)}>
      <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{children}</h3>
      {aside ? <div className="text-[11px] text-muted-foreground">{aside}</div> : null}
    </div>
  )
}

/** Wraps any element with a Radix tooltip. */
export function Hint({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-[12px] leading-snug">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function Stat({
  label,
  value,
  sub,
  emphasis,
  hint,
  className,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  emphasis?: boolean
  hint?: ReactNode
  className?: string
}) {
  const labelEl = (
    <span
      className={cn(
        "text-[11px] leading-4 font-medium tracking-[0.04em] text-muted-foreground uppercase",
        hint && "cursor-help underline decoration-subtle/60 decoration-dotted underline-offset-[3px]",
      )}
    >
      {label}
    </span>
  )
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {hint ? (
        <Hint label={hint}>
          <button type="button" className="flex h-4 w-fit items-center rounded-sm text-left">
            {labelEl}
          </button>
        </Hint>
      ) : (
        <span className="flex h-4 items-center">{labelEl}</span>
      )}
      <span className={cn("font-mono text-[22px] leading-none font-medium tracking-tight tabular-nums", emphasis && "text-brand")}>{value}</span>
      {sub ? <span className="text-[12px] leading-snug text-muted-foreground tabular-nums">{sub}</span> : null}
    </div>
  )
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: color }} />
}

/** A thin horizontal bar; `hatched` adds a non-colour cue for friction. */
export function Bar({
  value,
  max,
  className,
  fillClassName,
  hatched,
  style,
}: {
  value: number
  max: number
  className?: string
  fillClassName?: string
  hatched?: boolean
  style?: React.CSSProperties
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0
  return (
    <div aria-hidden className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-faint", className)}>
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full bg-foreground/70 transition-[width] duration-200", hatched && "hatch-bg", fillClassName)}
        style={{ width: `${pct}%`, ...style }}
      />
    </div>
  )
}
