import { Keyboard } from "lucide-react"

/** Hands the armed machine from the GLM estimate to Jev's live run (Space does the same). */
export function UltrasortButton({ onPress, pressed, reducedMotion }: { onPress: () => void; pressed: boolean; reducedMotion: boolean }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={pressed}
      aria-pressed={pressed}
      className="group pointer-events-auto inline-flex items-center gap-3 rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white shadow-md transition hover:brightness-110 disabled:opacity-60 disabled:hover:brightness-100"
    >
      <span className="relative flex size-2.5">
        {reducedMotion || pressed ? null : <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" />}
        <span className="relative inline-flex size-2.5 rounded-full bg-white" />
      </span>
      Ultrasort
      <kbd className="inline-flex items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 font-mono text-[11px] font-medium">
        <Keyboard className="size-3" />
        space
      </kbd>
    </button>
  )
}
