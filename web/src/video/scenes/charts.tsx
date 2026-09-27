import { useMemo } from "react"
import { hierarchy, pack } from "d3-hierarchy"
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { C, FONT, MONO, frictionColor, hue, int, pct } from "../theme"
import { CountUp, Eyebrow, Headline, Stage } from "../kit"
import { clamp, easeOut, useProgress, useSpring } from "../anim"
import type { ChangeScene, FrictionScene, LanguagesScene, MapCategory, MapScene, SignalsScene, SpotlightScene, TopScene } from "../types"

/* ---------------------------------------------------------------- map */

type PackDatum = { id: string; title: string; value?: number; children?: PackDatum[]; ci?: number; other?: boolean }

export function MapPack({ scene }: { scene: MapScene }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const cats = scene.data.categories
  const S = 800
  const nodes = useMemo(() => {
    const root = hierarchy<PackDatum>({
      id: "root",
      title: "",
      children: cats.map((c, ci) => ({
        id: c.id,
        title: c.title,
        ci,
        other: c.is_other,
        children: c.children.length
          ? c.children.map((l) => ({ id: l.id, title: l.title, value: l.conversations, ci, other: c.is_other }))
          : [{ id: `${c.id}_all`, title: c.title, value: c.conversations, ci, other: c.is_other }],
      })),
    })
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    return pack<PackDatum>().size([S, S]).padding((d) => (d.depth === 0 ? 16 : 5))(root).descendants().slice(1)
  }, [cats])
  const zoom = interpolate(frame, [0, 240], [0.96, 1.03], clamp)
  const ranked = [...cats].map((c, i) => ({ c, i })).sort((a, b) => b.c.conversations - a.c.conversations)
  return (
    <Stage>
      <div style={{ display: "flex", height: "100%", gap: 60 }}>
        <div style={{ width: 760, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Eyebrow>The usage map</Eyebrow>
          <Headline text={scene.headline} size={68} maxWidth={740} />
          <div style={{ marginTop: 44, display: "flex", flexDirection: "column", gap: 14 }}>
            {ranked.map(({ c, i }, k) => (
              <Legend key={c.id} cat={c} index={i} delay={18 + k * 4} />
            ))}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width={S} height={S} style={{ overflow: "visible", transform: `scale(${zoom})` }}>
            {nodes.map((n, k) => {
              const d = n.data
              const isCat = n.depth === 1
              const delay = isCat ? 6 + (d.ci ?? 0) * 4 : 20 + (d.ci ?? 0) * 4 + (k % 7) * 1.5
              const s = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.6 } })
              return (
                <circle
                  key={d.id}
                  cx={n.x}
                  cy={n.y}
                  r={Math.max(0, n.r * s)}
                  fill={isCat ? hue(d.ci ?? 0, d.other, 0.1) : hue(d.ci ?? 0, d.other, 0.55)}
                  stroke={hue(d.ci ?? 0, d.other, isCat ? 0.55 : 0.9)}
                  strokeWidth={isCat ? 2 : 1.2}
                />
              )
            })}
            {nodes
              .filter((n) => n.depth === 1 && n.r > 70)
              .map((n) => {
                const s = spring({ frame: frame - 36 - (n.data.ci ?? 0) * 4, fps, config: { damping: 200 } })
                return (
                  <g key={`${n.data.id}_label`} opacity={s}>
                    <text
                      x={n.x}
                      y={n.y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={C.text}
                      stroke={C.bg}
                      strokeWidth={6}
                      paintOrder="stroke"
                      style={{ fontFamily: FONT, fontSize: Math.min(30, n.r / 3.4), fontWeight: 600 }}
                    >
                      {n.data.title}
                    </text>
                  </g>
                )
              })}
          </svg>
        </div>
      </div>
    </Stage>
  )
}

function Legend({ cat, index, delay }: { cat: MapCategory; index: number; delay: number }) {
  const s = useSpring(delay)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: s, transform: `translateX(${(1 - s) * -24}px)` }}>
      <div style={{ width: 16, height: 16, borderRadius: 8, background: hue(index, cat.is_other) }} />
      <div style={{ fontSize: 30, flex: 1, color: cat.is_other ? C.muted : C.text }}>{cat.title}</div>
      <CountUp value={cat.share} format={(x) => pct(x)} delay={delay} duration={30} style={{ fontSize: 28, color: C.muted }} />
    </div>
  )
}

/* ---------------------------------------------------------------- bars */

function BarRow({
  rank,
  title,
  sub,
  frac,
  color,
  value,
  delay,
}: {
  rank: number
  title: string
  sub: string
  frac: number
  color: string
  value: React.ReactNode
  delay: number
}) {
  const s = useSpring(delay)
  const grow = useProgress(delay + 4, delay + 34)
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 560px 1fr", alignItems: "center", gap: 24, opacity: s }}>
      <div style={{ fontFamily: MONO, fontSize: 26, color: C.faint }}>{String(rank).padStart(2, "0")}</div>
      <div style={{ transform: `translateX(${(1 - s) * -20}px)` }}>
        <div style={{ fontSize: 33, fontWeight: 560, letterSpacing: "-0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 19, color: C.muted, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div style={{ flex: 1, height: 30, position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, borderRadius: 8, background: "oklch(1 0 0 / 0.04)" }} />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${frac * grow * 100}%`,
              borderRadius: 8,
              background: color,
              boxShadow: `0 0 40px ${color}`,
            }}
          />
        </div>
        <div style={{ width: 150, textAlign: "right", fontSize: 32 }}>{value}</div>
      </div>
    </div>
  )
}

export function TopWorkflows({ scene, categoryIndex }: { scene: TopScene; categoryIndex: (title: string) => number }) {
  const items = scene.data.items
  const max = Math.max(...items.map((i) => i.share), 1e-9)
  return (
    <Stage>
      <Eyebrow>Largest workflows · share of all conversations</Eyebrow>
      <Headline text={scene.headline} size={62} maxWidth={1680} />
      <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 40 }}>
        {items.map((it, k) => (
          <BarRow
            key={it.id}
            rank={k + 1}
            title={it.title}
            sub={`${it.category} · ${int(it.conversations)} conversations · ${int(it.people)} people`}
            frac={it.share / max}
            color={hue(categoryIndex(it.category), false, 0.85)}
            value={<CountUp value={it.share} format={(x) => pct(x)} delay={16 + k * 5} duration={34} />}
            delay={16 + k * 5}
          />
        ))}
      </div>
    </Stage>
  )
}

export function Friction({ scene }: { scene: FrictionScene }) {
  const items = scene.data.items
  const max = Math.max(...items.map((i) => i.friction_conversations), 1)
  const ring = useProgress(8, 58)
  const R = 150
  const circ = 2 * Math.PI * R
  const share = scene.data.overall_share
  return (
    <Stage>
      <Eyebrow color={C.friction}>Friction · where the assistant lets people down</Eyebrow>
      <Headline text={scene.headline} size={62} maxWidth={1680} />
      <div style={{ display: "flex", gap: 90, marginTop: 36, alignItems: "center" }}>
        <div style={{ width: 380, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ position: "relative", width: 2 * R + 40, height: 2 * R + 40 }}>
            <svg width={2 * R + 40} height={2 * R + 40} style={{ transform: "rotate(-90deg)" }}>
              <circle cx={R + 20} cy={R + 20} r={R} fill="none" stroke="oklch(1 0 0 / 0.07)" strokeWidth={26} />
              <circle
                cx={R + 20}
                cy={R + 20}
                r={R}
                fill="none"
                stroke={C.friction}
                strokeWidth={26}
                strokeLinecap="round"
                strokeDasharray={`${circ * share * ring} ${circ}`}
                style={{ filter: `drop-shadow(0 0 18px ${C.friction})` }}
              />
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CountUp value={share} format={(x) => pct(x)} delay={8} duration={50} style={{ fontSize: 72, fontWeight: 500 }} />
            </div>
          </div>
          <div style={{ fontSize: 28, color: C.muted, textAlign: "center", marginTop: 18, lineHeight: 1.3 }}>
            of all conversations show
            <br />a friction signal
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
          {items.map((it, k) => (
            <BarRow
              key={it.id}
              rank={k + 1}
              title={it.title}
              sub={`${pct(it.friction_share)} of its ${int(it.conversations)} conversations`}
              frac={it.friction_conversations / max}
              color={frictionColor(it.friction_share, 0.9)}
              value={<CountUp value={it.friction_conversations} format={int} delay={18 + k * 5} duration={34} />}
              delay={18 + k * 5}
            />
          ))}
          <div style={{ fontFamily: MONO, fontSize: 20, color: C.faint, marginLeft: 94 }}>
            Ranked by conversations with a friction signal · colour = friction rate
          </div>
        </div>
      </div>
    </Stage>
  )
}

/* ---------------------------------------------------------------- signals */

export function Signals({ scene }: { scene: SignalsScene }) {
  const frame = useCurrentFrame()
  const per = 10
  const colors = ["oklch(0.78 0.15 50)", "oklch(0.74 0.15 30)", "oklch(0.8 0.13 75)", "oklch(0.7 0.16 15)"]
  return (
    <Stage style={{ justifyContent: "center" }}>
      <Eyebrow color={C.friction}>How friction shows up</Eyebrow>
      <Headline text={scene.headline} size={66} maxWidth={1680} />
      <div style={{ display: "flex", flexDirection: "column", gap: 52, marginTop: 70 }}>
        {scene.data.items.map((it, k) => {
          const dots = Math.max(1, Math.round(it.conversations / per))
          const delay = 16 + k * 8
          const shown = interpolate(frame, [delay, delay + 40], [0, dots], { ...clamp, easing: easeOut })
          return (
            <div key={it.signal} style={{ display: "grid", gridTemplateColumns: "470px 1fr 150px", alignItems: "center", gap: 30 }}>
              <div style={{ fontSize: 36, fontWeight: 540, letterSpacing: "-0.015em" }}>{it.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 9, width: 1000 }}>
                {Array.from({ length: dots }, (_, i) => {
                  const o = Math.min(1, Math.max(0, shown - i))
                  return (
                    <div
                      key={i}
                      style={{
                        width: 19,
                        height: 19,
                        borderRadius: 10,
                        background: colors[k % colors.length],
                        opacity: o,
                        transform: `scale(${0.4 + 0.6 * o})`,
                      }}
                    />
                  )
                })}
              </div>
              <CountUp value={it.conversations} format={int} delay={delay} duration={40} style={{ fontSize: 40, textAlign: "right" }} />
            </div>
          )
        })}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 20, color: C.faint, marginTop: 36 }}>
        One dot ≈ {per} conversations · a conversation can show more than one signal
      </div>
    </Stage>
  )
}

/* ---------------------------------------------------------------- spotlight */

export function Spotlight({ scene }: { scene: SpotlightScene }) {
  const d = scene.data
  const insight = useSpring(70)
  const stats = [
    { label: "of all conversations", node: <CountUp value={d.share} format={(x) => pct(x)} delay={20} /> },
    { label: "people", node: <CountUp value={d.people} format={int} delay={24} /> },
    {
      label: "show friction",
      node: <CountUp value={d.friction_share ?? 0} format={(x) => pct(x)} delay={28} style={{ color: frictionColor(d.friction_share) }} />,
    },
  ]
  return (
    <Stage style={{ justifyContent: "center" }}>
      <Eyebrow color={C.accent}>
        Spotlight · {d.category} · {d.title}
      </Eyebrow>
      <Headline text={scene.headline} size={64} maxWidth={1680} />
      <div style={{ display: "flex", gap: 70, marginTop: 44 }}>
        <div style={{ width: 760 }}>
          <div style={{ display: "flex", gap: 22 }}>
            {stats.map((s, i) => (
              <StatCard key={s.label} delay={18 + i * 5} label={s.label}>
                {s.node}
              </StatCard>
            ))}
          </div>
          <div
            style={{
              marginTop: 40,
              opacity: insight,
              transform: `translateY(${(1 - insight) * 16}px)`,
              borderLeft: `6px solid ${C.accent}`,
              paddingLeft: 28,
              fontSize: 36,
              lineHeight: 1.3,
              letterSpacing: "-0.01em",
            }}
          >
            {scene.insight}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: MONO, fontSize: 20, color: C.friction, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 18 }}>
            What breaks · published problems
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {d.problems.slice(0, 3).map((p, i) => (
              <Problem key={i} text={p} delay={34 + i * 12} />
            ))}
            {d.problems.length === 0 ? (
              <div style={{ fontSize: 28, color: C.muted }}>No specific frustration is established for this workflow yet.</div>
            ) : null}
          </div>
        </div>
      </div>
    </Stage>
  )
}

function StatCard({ children, label, delay }: { children: React.ReactNode; label: string; delay: number }) {
  const s = useSpring(delay)
  return (
    <div
      style={{
        flex: 1,
        background: C.bgRaised,
        border: `1px solid ${C.line}`,
        borderRadius: 20,
        padding: "26px 26px 22px",
        opacity: s,
        transform: `translateY(${(1 - s) * 24}px)`,
      }}
    >
      <div style={{ fontSize: 52, fontWeight: 500, letterSpacing: "-0.03em" }}>{children}</div>
      <div style={{ fontSize: 22, color: C.muted, marginTop: 6 }}>{label}</div>
    </div>
  )
}

function Problem({ text, delay }: { text: string; delay: number }) {
  const s = useSpring(delay)
  return (
    <div
      style={{
        background: C.frictionSoft,
        border: `1px solid oklch(0.74 0.16 50 / 0.35)`,
        borderRadius: 16,
        padding: "20px 24px",
        fontSize: 27,
        lineHeight: 1.3,
        opacity: s,
        transform: `translateX(${(1 - s) * 40}px)`,
      }}
    >
      {text}
    </div>
  )
}

/* ---------------------------------------------------------------- languages */

export function Languages({ scene }: { scene: LanguagesScene }) {
  const items = scene.data.items
  const total = items.reduce((a, b) => a + b.share, 0) || 1
  const grow = useProgress(14, 60)
  const colors = [250, 185, 150, 290, 345, 105, 222].map((h) => `oklch(0.76 0.11 ${h})`)
  const lefts = items.map((_, i) => (items.slice(0, i).reduce((a, b) => a + b.share, 0) / total) * 100)
  return (
    <Stage style={{ justifyContent: "center" }}>
      <Eyebrow>Who is asking</Eyebrow>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 60 }}>
        <Headline text={scene.headline} size={68} maxWidth={1100} />
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <CountUp value={scene.data.languages} format={int} delay={10} duration={40} style={{ fontSize: 120, fontWeight: 500, letterSpacing: "-0.04em" }} />
          <div style={{ fontFamily: MONO, fontSize: 22, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>languages</div>
        </div>
      </div>
      <div style={{ display: "flex", height: 110, marginTop: 70, borderRadius: 18, overflow: "hidden", background: "oklch(1 0 0 / 0.04)" }}>
        {items.map((it, i) => (
          <div
            key={it.name}
            style={{
              width: `${(it.share / total) * 100 * grow}%`,
              background: colors[i % colors.length],
              opacity: it.name.startsWith("Other") ? 0.35 : 0.9,
              borderRight: `3px solid ${C.bg}`,
            }}
          />
        ))}
      </div>
      <div style={{ position: "relative", height: 100, marginTop: 20 }}>
        {items.map((it, i) => {
          return it.share / total >= BIG ? (
            <LangLabel key={it.name} left={lefts[i]} name={it.name} share={it.share} color={colors[i % colors.length]} delay={30 + i * 5} />
          ) : null
        })}
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 30, flexWrap: "wrap" }}>
        {items.map((it, i) =>
          it.share / total < BIG ? <LangChip key={it.name} name={it.name} share={it.share} color={colors[i % colors.length]} delay={46 + i * 4} /> : null,
        )}
      </div>
    </Stage>
  )
}

const BIG = 0.075

function LangChip({ name, share, color, delay }: { name: string; share: number; color: string; delay: number }) {
  const s = useSpring(delay)
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        borderRadius: 999,
        background: C.bgRaised,
        border: `1px solid ${C.line}`,
        opacity: s,
        transform: `translateY(${(1 - s) * 14}px)`,
      }}
    >
      <div style={{ width: 14, height: 14, borderRadius: 7, background: color }} />
      <div style={{ fontSize: 26 }}>{name}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.muted }}>{pct(share)}</div>
    </div>
  )
}

function LangLabel({ left, name, share, color, delay }: { left: number; name: string; share: number; color: string; delay: number }) {
  const s = useSpring(delay)
  return (
    <div style={{ position: "absolute", left: `${left}%`, opacity: s, paddingLeft: 4, borderLeft: `3px solid ${color}`, paddingTop: 4 }}>
      <div style={{ fontSize: 28, fontWeight: 540, whiteSpace: "nowrap", paddingLeft: 10 }}>{name}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.muted, paddingLeft: 10 }}>{pct(share)}</div>
    </div>
  )
}

/* ---------------------------------------------------------------- what changed */

export function Change({ scene }: { scene: ChangeScene }) {
  const d = scene.data
  const max = Math.max(...d.items.map((i) => i.after), 1)
  const frame = useCurrentFrame()
  const arrow = interpolate(frame, [30, 50], [0, 1], { ...clamp, easing: easeOut })
  return (
    <Stage>
      <Eyebrow color={C.accent}>What changed · new conversations since the last map</Eyebrow>
      <Headline text={scene.headline} size={62} maxWidth={1680} />
      <div style={{ display: "flex", gap: 90, marginTop: 44 }}>
        <div style={{ width: 420, display: "flex", flexDirection: "column", gap: 36 }}>
          <div>
            <CountUp
              value={d.added_conversations}
              format={(x) => `+${int(x)}`}
              delay={8}
              duration={40}
              style={{ fontSize: 120, fontWeight: 500, letterSpacing: "-0.04em", color: C.accent }}
            />
            <div style={{ fontSize: 28, color: C.muted, marginTop: 4 }}>new conversations</div>
            <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint, marginTop: 10 }}>
              {int(d.conversations_before)} → {int(d.conversations_after)}
            </div>
          </div>
          <div style={{ opacity: arrow }}>
            <div style={{ fontFamily: MONO, fontSize: 20, color: C.friction, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              Friction share
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 8, fontFamily: MONO, fontSize: 44 }}>
              <span style={{ color: C.muted }}>{pct(d.friction_share_before)}</span>
              <span style={{ color: C.faint, fontSize: 32 }}>→</span>
              <span style={{ color: frictionColor(d.friction_share_after) }}>{pct(d.friction_share_after)}</span>
            </div>
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
          {d.items.map((it, k) => (
            <GrowRow key={it.id} item={it} max={max} delay={14 + k * 5} />
          ))}
          <div style={{ fontFamily: MONO, fontSize: 19, color: C.faint }}>
            Workflows that grew most · faint bar = previous map · compared with {d.base_snapshot_id}
          </div>
        </div>
      </div>
    </Stage>
  )
}

function GrowRow({ item, max, delay }: { item: ChangeScene["data"]["items"][number]; max: number; delay: number }) {
  const s = useSpring(delay)
  const grow = useProgress(delay + 10, delay + 40)
  const before = item.before / max
  const after = item.after / max
  const now = before + (after - before) * grow
  const gain = item.after - item.before
  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px 1fr 120px", alignItems: "center", gap: 24, opacity: s }}>
      <div style={{ fontSize: 32, fontWeight: 560, letterSpacing: "-0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {item.title}
      </div>
      <div style={{ position: "relative", height: 30 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 8, background: "oklch(1 0 0 / 0.04)" }} />
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${now * 100}%`, borderRadius: 8, background: C.accent, boxShadow: `0 0 30px ${C.accent}` }} />
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${before * 100}%`, borderRadius: 8, background: "oklch(0.5 0.02 265)" }} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 30, textAlign: "right", color: gain > 0 ? C.accent : C.muted }}>
        {gain > 0 ? "+" : ""}
        {int(gain * grow)}
      </div>
    </div>
  )
}
