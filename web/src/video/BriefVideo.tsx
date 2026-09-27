// The one-minute brief as a Remotion composition. The same component plays in
// the browser (@remotion/player) and renders to MP4 (web/video-render).

import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { C, FONT, MONO } from "./theme"
import { clamp, modelName } from "./anim"
import type { Brief, BriefVideoProps, Scene } from "./types"
import { Change, Friction, Languages, MapPack, Signals, Spotlight, TopWorkflows } from "./scenes/charts"
import { Intro, Outro, Takeaways } from "./scenes/text"

const SCENE_NAMES: Record<Scene["type"], string> = {
  intro: "Intro",
  change: "What changed",
  map: "Map",
  top_workflows: "Top workflows",
  friction: "Friction",
  signals: "Signals",
  spotlight: "Spotlight",
  languages: "Languages",
  takeaways: "Takeaways",
  outro: "Receipts",
}

function SceneView({ scene, brief }: { scene: Scene; brief: Brief }) {
  const map = brief.scenes.find((s) => s.type === "map")
  const categoryIndex = (title: string) =>
    map && map.type === "map" ? Math.max(0, map.data.categories.findIndex((c) => c.title === title)) : 0
  switch (scene.type) {
    case "intro":
      return <Intro scene={scene} brief={brief} />
    case "change":
      return <Change scene={scene} />
    case "map":
      return <MapPack scene={scene} />
    case "top_workflows":
      return <TopWorkflows scene={scene} categoryIndex={categoryIndex} />
    case "friction":
      return <Friction scene={scene} />
    case "signals":
      return <Signals scene={scene} />
    case "spotlight":
      return <Spotlight scene={scene} />
    case "languages":
      return <Languages scene={scene} />
    case "takeaways":
      return <Takeaways scene={scene} />
    case "outro":
      return <Outro scene={scene} brief={brief} />
    default:
      return null
  }
}

function Backdrop() {
  const frame = useCurrentFrame()
  const x = 30 + Math.sin(frame / 200) * 8
  const y = 20 + Math.cos(frame / 240) * 6
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 800px at ${x}% ${y}%, oklch(0.24 0.03 265) 0%, ${C.bg} 60%)`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(oklch(1 0 0 / 0.05) 1.2px, transparent 1.2px)",
          backgroundSize: "34px 34px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
    </AbsoluteFill>
  )
}

/** Brand, snapshot and a segmented progress bar that names the current scene. */
function Chrome({ brief }: { brief: Brief }) {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const current = brief.scenes.findIndex((s) => frame >= s.from_frame && frame < s.from_frame + s.frames)
  const fadeIn = interpolate(frame, [0, 20], [0, 1], clamp)
  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: C.text, opacity: fadeIn, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 56, left: 120, right: 120, display: "flex", alignItems: "center", gap: 16 }}>
        <svg width={34} height={34} viewBox="0 0 32 32">
          <rect width="32" height="32" rx="8" fill={C.text} />
          <circle cx="13" cy="17" r="7" fill="none" stroke={C.bg} strokeWidth="2" />
          <circle cx="21.5" cy="12" r="4" fill={C.bg} />
        </svg>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>logless</div>
        <div style={{ fontFamily: MONO, fontSize: 18, color: C.faint, letterSpacing: "0.1em", textTransform: "uppercase", marginLeft: 10 }}>
          Video brief
        </div>
        <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 18, color: C.faint }}>{brief.dataset.workspace}</div>
      </div>
      <div style={{ position: "absolute", bottom: 52, left: 120, right: 120 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {brief.scenes.map((s, i) => {
            const p = interpolate(frame, [s.from_frame, s.from_frame + s.frames], [0, 1], clamp)
            return (
              <div key={i} style={{ flex: s.frames, height: 4, borderRadius: 2, background: "oklch(1 0 0 / 0.1)", overflow: "hidden" }}>
                <div style={{ width: `${p * 100}%`, height: "100%", background: i === current ? C.text : "oklch(1 0 0 / 0.45)" }} />
              </div>
            )
          })}
        </div>
        <div style={{ display: "flex", marginTop: 14, fontFamily: MONO, fontSize: 17, color: C.faint, letterSpacing: "0.06em" }}>
          <span style={{ color: C.muted, textTransform: "uppercase" }}>{current >= 0 ? SCENE_NAMES[brief.scenes[current].type] : ""}</span>
          <span style={{ marginLeft: "auto" }}>
            Words by {modelName(brief.model)} · numbers from the published map · {Math.floor(frame / fps)}s / {Math.round(durationInFrames / fps)}s
          </span>
        </div>
      </div>
    </AbsoluteFill>
  )
}

export function BriefVideo({ brief }: BriefVideoProps) {
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      <Backdrop />
      {brief.scenes.map((s, i) => (
        <Sequence key={i} from={s.from_frame} durationInFrames={s.frames} name={SCENE_NAMES[s.type]}>
          <SceneView scene={s} brief={brief} />
        </Sequence>
      ))}
      <Chrome brief={brief} />
    </AbsoluteFill>
  )
}
