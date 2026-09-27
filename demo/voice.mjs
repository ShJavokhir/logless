// Narration: one macOS `say` clip per caption chunk, silence-trimmed, 48 kHz mono WAV.
// usage: node voice.mjs <workdir>   → <workdir>/voice/*.wav + <workdir>/voice.json
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = process.argv[2] ?? join(HERE, ".work")
const cfg = JSON.parse(readFileSync(join(HERE, "beats.json"), "utf8"))
const dir = join(WORK, "voice")
mkdirSync(dir, { recursive: true })

const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()
// trim leading/trailing silence so chunk timing is exact
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse"

// {placeholders} come from what the last take read off the screen (rec/facts.json),
// falling back to beats.json "defaults" (used only to pace a take before it exists)
let facts = { ...(cfg.defaults ?? {}) }
try {
  facts = { ...facts, ...JSON.parse(readFileSync(join(WORK, "rec", "facts.json"), "utf8")) }
} catch {}
const fill = (t) => t?.replace(/\{(\w+)\}/g, (_, k) => {
  if (facts[k] === undefined || facts[k] === null) throw new Error(`no value for {${k}}`)
  return String(facts[k])
})
for (const beat of cfg.beats) for (const c of beat.chunks) Object.assign(c, { spoken: fill(c.spoken), caption: fill(c.caption) })

const out = { voice: cfg.voice, rate: cfg.rate, gap: cfg.gap, beats: {} }
let words = 0
for (const beat of cfg.beats) {
  out.beats[beat.id] = beat.chunks.map((c, i) => {
    const base = join(dir, `${beat.id}-${i}`)
    const rate = String(beat.rate ?? cfg.rate)
    execFileSync("say", ["-v", cfg.voice, "-r", rate, "-o", `${base}.aiff`, c.spoken])
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", `${base}.aiff`, "-af", TRIM, "-ar", "48000", "-ac", "1", `${base}.wav`])
    words += c.spoken.split(/\s+/).filter(Boolean).length
    return { file: `${base}.wav`, dur: +dur(`${base}.wav`).toFixed(3), caption: c.caption, at: c.at, spoken: c.spoken }
  })
}
writeFileSync(join(WORK, "voice.json"), JSON.stringify(out, null, 1))
let total = 0
for (const [id, cs] of Object.entries(out.beats)) {
  const s = cs.reduce((a, c) => a + c.dur, 0)
  total += s
  console.log(`${id.padEnd(8)} ${cs.map((c) => c.dur.toFixed(2)).join(" + ")} = ${s.toFixed(2)} s`)
}
console.log(`total voice ${total.toFixed(2)} s · ${words} spoken words`)
