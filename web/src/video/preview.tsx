// Dev-only page (brief-preview.html, not part of the production build): plays a
// brief in the Player. ?frame=N seeks and pauses; ?live=1 loads GET /api/brief;
// ?stress=1 swaps in maximum-length copy to check wrapping.
import { createRoot } from "react-dom/client"
import { Player } from "@remotion/player"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import { BriefVideo } from "./BriefVideo"
import type { Brief } from "./types"
import sample from "./sample-brief.json"

const q = new URLSearchParams(location.search)
const frame = Number(q.get("frame") ?? "-1")
const LONG = "Everyday questions keep hitting refusals the assistant should never make here"

async function load(): Promise<Brief> {
  let brief = sample as unknown as Brief
  if (q.get("live")) brief = (await (await fetch("/api/brief")).json()).brief as Brief
  if (q.get("stress")) {
    brief = structuredClone(brief)
    for (const s of brief.scenes) {
      s.headline = LONG.split(" ").slice(0, 10).join(" ")
      if (s.type === "takeaways") s.bullets = s.bullets.map(() => LONG + " today")
      if (s.type === "spotlight") s.insight = `${LONG} ${LONG} and more`
      if (s.type === "intro") s.kicker = LONG + " again"
    }
    brief.title = LONG.split(" ").slice(0, 10).join(" ")
  }
  return brief
}

void load().then((brief) =>
  createRoot(document.getElementById("root")!).render(
    <Player
      ref={(p) => {
        if (p && frame >= 0) p.seekTo(frame)
      }}
      component={BriefVideo}
      inputProps={{ brief }}
      durationInFrames={brief.duration_frames}
      fps={brief.fps}
      compositionWidth={brief.width}
      compositionHeight={brief.height}
      style={{ width: "100vw", aspectRatio: "16 / 9" }}
      controls
      autoPlay={frame < 0}
    />,
  ),
)
