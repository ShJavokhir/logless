export function Lead({ eyebrow, title, points }: { eyebrow: string; title: string; points: string[] }) {
  return (
    <div className="rounded-xl border bg-card px-5 py-4">
      <p className="text-[12px] font-medium tracking-wide text-brand uppercase">{eyebrow}</p>
      <h2 className="mt-1.5 text-[18px] leading-snug font-semibold tracking-[-0.01em] text-balance">{title}</h2>
      {points.length ? (
        <ol className="mt-2.5 grid gap-1.5">
          {points.map((p, i) => (
            <li key={p} className="flex gap-2 text-[12.5px] leading-snug text-muted-foreground">
              <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-muted font-mono text-[10px] text-foreground">{i + 1}</span>
              {p}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
