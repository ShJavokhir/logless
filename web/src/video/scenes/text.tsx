import { interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { C, MONO, hue, int } from "../theme"
import { CountUp, Eyebrow, Headline, Stage } from "../kit"
import { clamp, easeOut, modelName, rand, useSpring } from "../anim"
import type { Brief, IntroScene, OutroScene, TakeawaysScene } from "../types"

function period(b: Brief) {
  const f = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  const year = b.dataset.period_end.slice(0, 4)
  return `${f(b.dataset.period_start)} – ${f(b.dataset.period_end)}, ${year}`
}

/** Category shares from the map scene, used to colour the intro's dot field. */
function categoryMix(b: Brief): { share: number; i: number; other: boolean }[] {
  const map = b.scenes.find((s) => s.type === "map")
  if (!map || map.type !== "map") return [{ share: 1, i: 0, other: false }]
  return map.data.categories.map((c, i) => ({ share: c.share, i, other: c.is_other }))
}

/** One dot per ~N conversations flies out from the centre and settles into a slow drift. */
function DotField({ brief }: { brief: Brief }) {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const n = 420
  const mix = categoryMix(brief)
  const cum: number[] = []
  mix.reduce((a, m) => (cum.push(a + m.share), a + m.share), 0)
  const total = cum[cum.length - 1] || 1
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
      {Array.from({ length: n }, (_, k) => {
        const r1 = rand(k + 1)
        const r2 = rand(k + 1000)
        const r3 = rand(k + 2000)
        const ci = cum.findIndex((c) => (k / n) * total <= c)
        const m = mix[Math.max(0, ci)]
        const cx = width * 0.72
        const cy = height * 0.5
        const angle = r1 * Math.PI * 2
        const radius = 120 + Math.sqrt(r2) * 520
        const delay = r3 * 30
        const t = interpolate(frame, [delay, delay + 40], [0, 1], { ...clamp, easing: easeOut })
        const drift = Math.sin(frame / 50 + k) * 6
        const x = cx + Math.cos(angle + frame / 900) * radius * t + drift
        const y = cy + Math.sin(angle + frame / 900) * radius * 0.78 * t
        return <circle key={k} cx={x} cy={y} r={2.2 + r2 * 3.2} fill={hue(m.i, m.other, 0.25 + 0.55 * t * (0.4 + r3 * 0.6))} />
      })}
    </svg>
  )
}

export function Intro({ scene, brief }: { scene: IntroScene; brief: Brief }) {
  const stats = [
    { label: "conversations", value: brief.totals.conversations },
    { label: "people", value: brief.totals.people },
    { label: "languages", value: brief.totals.languages },
  ]
  const kicker = useSpring(28)
  return (
    <>
      <DotField brief={brief} />
      <Stage style={{ justifyContent: "center" }}>
        <Eyebrow>
          {brief.dataset.name} · {period(brief)}
        </Eyebrow>
        <Headline text={scene.headline} size={scene.headline.length > 46 ? 88 : 104} maxWidth={1240} />
        {scene.kicker ? (
          <div style={{ fontSize: 38, color: C.muted, marginTop: 30, maxWidth: 1000, opacity: kicker, letterSpacing: "-0.01em" }}>
            {scene.kicker}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 80, marginTop: 80 }}>
          {stats.map((s, i) => (
            <Stat key={s.label} delay={34 + i * 6} value={s.value} label={s.label} />
          ))}
        </div>
      </Stage>
    </>
  )
}

function Stat({ value, label, delay }: { value: number; label: string; delay: number }) {
  const s = useSpring(delay)
  return (
    <div style={{ opacity: s, transform: `translateY(${(1 - s) * 20}px)` }}>
      <CountUp value={value} format={int} delay={delay} duration={32} style={{ fontSize: 64, fontWeight: 500, letterSpacing: "-0.03em" }} />
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.muted, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 6 }}>
        {label}
      </div>
    </div>
  )
}

export function Takeaways({ scene }: { scene: TakeawaysScene }) {
  return (
    <Stage style={{ justifyContent: "center" }}>
      <Eyebrow color={C.accent}>What to do next</Eyebrow>
      <Headline text={scene.headline} size={80} />
      <div style={{ display: "flex", flexDirection: "column", gap: 34, marginTop: 64 }}>
        {scene.bullets.map((b, i) => (
          <Bullet key={i} index={i} text={b} delay={24 + i * 22} />
        ))}
      </div>
    </Stage>
  )
}

function Bullet({ index, text, delay }: { index: number; text: string; delay: number }) {
  const s = useSpring(delay)
  const frame = useCurrentFrame()
  const bar = interpolate(frame, [delay, delay + 26], [0, 1], { ...clamp, easing: easeOut })
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 40, opacity: s, transform: `translateX(${(1 - s) * -40}px)` }}>
      <div style={{ fontFamily: MONO, fontSize: 30, color: C.accent, width: 64 }}>{String(index + 1).padStart(2, "0")}</div>
      <div style={{ width: 6, height: 70, borderRadius: 3, background: C.accent, transform: `scaleY(${bar})` }} />
      <div style={{ fontSize: 50, fontWeight: 500, letterSpacing: "-0.02em", maxWidth: 1400 }}>{text}</div>
    </div>
  )
}

export function Outro({ scene, brief }: { scene: OutroScene; brief: Brief }) {
  const s = useSpring(2)
  const line = useSpring(22)
  return (
    <Stage style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
      <svg width={120} height={120} viewBox="0 0 32 32" style={{ transform: `scale(${0.6 + 0.4 * s})`, opacity: s, marginBottom: 44 }}>
        <rect width="32" height="32" rx="8" fill={C.text} />
        <circle cx="13" cy="17" r="7" fill="none" stroke={C.bg} strokeWidth="2" />
        <circle cx="21.5" cy="12" r="4" fill={C.bg} />
      </svg>
      <Headline text={scene.headline} size={72} align="center" maxWidth={1400} delay={8} />
      <div style={{ marginTop: 44, opacity: line, fontSize: 30, color: C.muted, maxWidth: 1300, lineHeight: 1.4 }}>
        Directed by {modelName(brief.model)} on Vultr Serverless Inference. Every number filled from the published map.
      </div>
      <div style={{ marginTop: 22, opacity: line, fontFamily: MONO, fontSize: 22, color: C.faint, letterSpacing: "0.04em" }}>
        {scene.data.pipeline} · {scene.data.snapshot_id}
      </div>
    </Stage>
  )
}
