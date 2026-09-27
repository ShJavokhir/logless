// Narration: one clip per caption chunk (ElevenLabs, or macOS `say` as fallback), silence-trimmed, 48 kHz mono WAV.
// usage: node voice.mjs <workdir>   → <workdir>/voice/*.wav + <workdir>/voice.json
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
for (const dir of ["rec", "rec_eval"]) {
  // rec_eval (a separately recorded Evaluation clip) wins for the facts it read
  try {
    facts = { ...facts, ...JSON.parse(readFileSync(join(WORK, dir, "facts.json"), "utf8")) }
  } catch {}
}
const fill = (t) => t?.replace(/\{(\w+)\}/g, (_, k) => {
  if (facts[k] === undefined || facts[k] === null) throw new Error(`no value for {${k}}`)
  return String(facts[k])
})
for (const beat of cfg.beats) for (const c of beat.chunks) Object.assign(c, { spoken: fill(c.spoken), caption: fill(c.caption) })

// ElevenLabs when ELEVENLABS_API_KEY is set (env or repo-root .env), else macOS `say`.
// Clips are cached by (voice, model, settings, text), so re-cuts don't re-bill.
const envKey = () => {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    return readFileSync(join(HERE, "..", ".env"), "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
  } catch {
    return undefined
  }
}
const EL_KEY = envKey()
const el = cfg.elevenlabs ?? {}
const cacheDir = join(WORK, "voice-cache")
mkdirSync(cacheDir, { recursive: true })
async function eleven(text, base) {
  const settings = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.0, ...(el.settings ?? {}) }
  const key = createHash("sha256").update(JSON.stringify([el.voice_id, el.model, settings, text])).digest("hex").slice(0, 16)
  const cached = join(cacheDir, `${key}.mp3`)
  if (!existsSync(cached)) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${el.voice_id}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": EL_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: el.model, voice_settings: settings }),
    })
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
    writeFileSync(cached, Buffer.from(await r.arrayBuffer()))
  }
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", cached, "-af", TRIM, "-ar", "48000", "-ac", "1", `${base}.wav`])
}

const out = { voice: EL_KEY ? `elevenlabs:${el.voice_id}` : cfg.voice, rate: cfg.rate, gap: cfg.gap, beats: {} }
console.log(`narration engine: ${EL_KEY ? "ElevenLabs " + el.model : "macOS say " + cfg.voice}`)
let words = 0
for (const beat of cfg.beats) {
  out.beats[beat.id] = []
  for (const [i, c] of beat.chunks.entries()) {
    const base = join(dir, `${beat.id}-${i}`)
    if (EL_KEY) {
      await eleven(c.spoken, base)
    } else {
      const rate = String(beat.rate ?? cfg.rate)
      execFileSync("say", ["-v", cfg.voice, "-r", rate, "-o", `${base}.aiff`, c.spoken])
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", `${base}.aiff`, "-af", TRIM, "-ar", "48000", "-ac", "1", `${base}.wav`])
    }
    words += c.spoken.split(/\s+/).filter(Boolean).length
    out.beats[beat.id].push({ file: `${base}.wav`, dur: +dur(`${base}.wav`).toFixed(3), caption: c.caption, at: c.at, spoken: c.spoken, ...(c.requires ? { requires: c.requires } : {}) })
  }
}
writeFileSync(join(WORK, "voice.json"), JSON.stringify(out, null, 1))
let total = 0
for (const [id, cs] of Object.entries(out.beats)) {
  const s = cs.reduce((a, c) => a + c.dur, 0)
  total += s
  console.log(`${id.padEnd(8)} ${cs.map((c) => c.dur.toFixed(2)).join(" + ")} = ${s.toFixed(2)} s`)
}
console.log(`total voice ${total.toFixed(2)} s · ${words} spoken words`)
