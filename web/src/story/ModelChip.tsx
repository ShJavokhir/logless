import { cn } from "@/lib/utils"

export function ModelChip({ label }: { label: string }) {
  const vultr = /vultr/i.test(label)
  const short = label.replace(/ \(Vultr Serverless Inference\)/, "").replace(/ \(rate[^)]*\)/, "")
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 font-mono text-[10.5px] whitespace-nowrap",
        vultr ? "border-brand/25 bg-brand-soft text-brand" : "bg-muted text-muted-foreground",
      )}
      title={label}
    >
      {short}
      {vultr ? <span className="ml-1 opacity-70">· Vultr</span> : null}
    </span>
  )
}
