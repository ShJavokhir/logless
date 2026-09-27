/* eslint-disable react/only-export-components -- a render entry, never hot-reloaded */
// Entry for server-side rendering (web/video-render/render.mjs). The Player in the
// app uses BriefVideo directly; this registers the same component as a composition.
import { useEffect, useState } from "react"
import { Composition, continueRender, delayRender, registerRoot } from "remotion"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import { BriefVideo } from "./BriefVideo"
import type { Brief, BriefVideoProps } from "./types"
import sample from "./sample-brief.json"

/** Hold the first frame until the webfonts are ready, so text metrics never shift. */
function WithFonts(props: BriefVideoProps) {
  const [handle] = useState(() => delayRender("fonts"))
  useEffect(() => {
    void Promise.all([
      document.fonts.load('600 40px "Geist Variable"'),
      document.fonts.load('400 40px "Geist Mono Variable"'),
    ]).then(() => document.fonts.ready).finally(() => continueRender(handle))
  }, [handle])
  return <BriefVideo {...props} />
}

function Root() {
  return (
    <Composition
      id="brief"
      component={WithFonts}
      defaultProps={{ brief: sample as unknown as Brief }}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.brief.duration_frames,
        fps: props.brief.fps,
        width: props.brief.width,
        height: props.brief.height,
      })}
      durationInFrames={1800}
      fps={30}
      width={1920}
      height={1080}
    />
  )
}

registerRoot(Root)
