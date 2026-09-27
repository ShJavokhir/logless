#!/usr/bin/env node
// Render a brief JSON to MP4 with the same composition the app plays.
//   node video-render/render.mjs <brief.json> <out.mp4> [--bundle dir] [--scale 0.5] [--concurrency N] [--gl angle]
//   node video-render/render.mjs --make-bundle <out-dir>      (pre-build the composition for a server)
// The brief is data only (words already gated, numbers filled by the backend);
// the composition code is ours, so nothing model-written is executed here.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bundle } from "@remotion/bundler"
import { renderMedia, selectComposition } from "@remotion/renderer"

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
if (argv[0] === "--make-bundle") {
  const dir = await bundle({ entryPoint: path.join(here, "../src/video/remotion-entry.tsx"), outDir: path.resolve(argv[1]) })
  console.log(JSON.stringify({ bundle: dir }))
  process.exit(0)
}
const [briefPath, outPath, ...rest] = argv
if (!briefPath || !outPath) {
  console.error("usage: render.mjs <brief.json> <out.mp4> [--scale 0.5] [--concurrency N]")
  process.exit(2)
}
const opt = (name, dflt) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : dflt
}
const brief = JSON.parse(readFileSync(briefPath, "utf8"))
const scale = Number(opt("--scale", "1"))
const concurrency = opt("--concurrency", null)

const t0 = Date.now()
const prebuilt = opt("--bundle", null)
const serveUrl = prebuilt
  ? path.resolve(prebuilt)
  : await bundle({ entryPoint: path.join(here, "../src/video/remotion-entry.tsx") })
const gl = opt("--gl", null)
const inputProps = { brief }
const composition = await selectComposition({ serveUrl, id: "brief", inputProps })
let last = -1
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: outPath,
  inputProps,
  scale,
  crf: 20,
  pixelFormat: "yuv420p",
  concurrency: concurrency ? Number(concurrency) : null,
  chromiumOptions: gl ? { gl } : {},
  onProgress: ({ progress }) => {
    const p = Math.floor(progress * 100)
    if (p !== last && p % 5 === 0) {
      last = p
      console.log(JSON.stringify({ progress: p }))
    }
  },
})
console.log(JSON.stringify({ done: true, seconds: (Date.now() - t0) / 1000, out: outPath }))
