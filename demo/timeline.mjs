// Cuts the recorded take into the demo timeline and writes the ffmpeg inputs.
//
// Reads <work>/rec/marks.json (+ voice.json) and writes:
//   <work>/timeline.json          human-readable plan (segments, speeds, narration, captions, total)
//   <work>/ff/inputs.txt          one ffmpeg input per line (already split into args, tab-separated)
//   <work>/ff/graph.txt           the -filter_complex script for the final encode
//   <work>/ff/total.txt           total duration in seconds
//
// Rules
// - Recording segments are cut on exact frame numbers of the 30 fps app.mp4, so the
//   planned times are the rendered times (no drift across cuts).
// - "fast" segments are waits (live run, story generation, leak check). They are
//   sped up by an integer factor (2× by default, 3–4× only if the wait is long) and
//   carry a "N× speed" pill. The runaway→kill stretch of the containment check is
//   always real time, so its bar and measured milliseconds are real.
// - "hold" segments end on a still screen; their tail is trimmed so each beat lasts
//   exactly as long as its narration (+ a short pad), but never below the hold minimum.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = process.argv[2] ?? join(HERE, ".work")
const FPS = 30
const main = JSON.parse(readFileSync(join(WORK, "rec", "marks.json"), "utf8"))
const dry = main.dry
// rec/marks.override.json: documented, hand-set marks (e.g. which of two containment attempts to use)
const override = existsSync(join(WORK, "rec", "marks.override.json")) ? JSON.parse(readFileSync(join(WORK, "rec", "marks.override.json"), "utf8")) : null
const marks = { ...main.marks, ...(override?.marks ?? {}) }
// rec_eval/: the Evaluation beat recorded as its own (free) clip → source 1
const evalClip = existsSync(join(WORK, "rec_eval", "marks.json")) ? JSON.parse(readFileSync(join(WORK, "rec_eval", "marks.json"), "utf8")).marks : null
const markSets = [marks, evalClip ?? {}]
const voice = JSON.parse(readFileSync(join(WORK, "voice.json"), "utf8"))
const OV = join(WORK, "overlays")

const P = {
  titleLead: 0.3, // silence before the first word
  titleGap: 0.22, // pause before "logless reads them…"
  titleTail: 0.2,
  tailPad: 0.3, // after a beat's last word before the cut
  beatGap: 0.2, // minimum pause between beats' narration
  closing: 2.4,
  maxTotal: 70,
}

const fr = (s) => Math.round(s * FPS) // seconds → frames
const T = (f) => f / FPS
const at = (spec, src = 0) => {
  const m = /^([a-z_]+)([+-][\d.]+)?$/.exec(spec)
  const ms = markSets[src]
  if (!m || ms[m[1]] === undefined) throw new Error(`unknown mark ${spec} (source ${src})`)
  return ms[m[1]] + (m[2] ? +m[2] : 0)
}

// A beat ends on its "hold" segment (trimmed to fit the narration). "fast" = a wait,
// sped up by the smallest integer factor that keeps it under that many seconds;
// "realtime" is documentation (always 1×).
const SEGS = dry
  ? [
      { beat: "map", from: "map_start", to: "map_end", hold: "map_badge+0.6" },
      { beat: "finding", from: "finding_start", to: "finding_end", hold: "finding_click+0.9" },
      { beat: "eval", from: "eval_start", to: "eval_end", hold: "eval_open+1.2" },
    ]
  : [
      { beat: "map", from: "map_start", to: "map_end", hold: "map_badge+0.6" },
      // live intake: the dot flight is real time; only the gate + republish wait is sped up
      { beat: "intake", from: "intake_start", to: "intake_click+0.4" },
      { beat: "intake", from: "intake_click+0.4", to: "intake_first", fast: 0.8, minWait: 1.5 },
      { beat: "intake", from: "intake_first", to: "intake_flight_end", realtime: true },
      { beat: "intake", from: "intake_flight_end", to: "intake_published", fast: 3.5, minWait: 1.2 },
      { beat: "intake", from: "intake_published", to: "intake_end", hold: "intake_toast+1.0" },
      { beat: "finding", from: "finding_start", to: "finding_end", hold: "finding_click+0.9" },
      // question: from just after the click to Verified is waiting (plan, programs, gVisor, gate)
      { beat: "ask", from: "ask_start", to: "ask_click+0.5" },
      { beat: "ask", from: "ask_click+0.5", to: "ask_done", fast: 8.0 },
      { beat: "ask", from: "ask_done", to: "ask_end", hold: "ask_done+1.2" },
      { beat: "details", from: "details_start", to: "details_end", hold: "details_cross+0.5" },
      { beat: "contain", from: "contain_start", to: "contain_click" },
      { beat: "contain", from: "contain_click", to: "runaway_seen", fast: 0.8, minWait: 1.5 },
      { beat: "contain", from: "runaway_seen", to: marks.rmrf_seen !== undefined ? "kill_seen+1.2" : "kill_seen+1.4", realtime: true },
      ...(marks.leak_bad_start !== undefined
        ? [
            // the card briefly showed a contradictory interim state ("Leak attempt was NOT
            // rejected" while the run was still active); cut from just before it to the final
            // state, and hold that final frame (see marks.override.json)
            { beat: "contain", from: "kill_seen+1.2", to: "rmrf_seen", fast: 1.2 },
            { beat: "contain", from: "rmrf_seen", to: "leak_bad_start", realtime: true },
          ]
        : marks.rmrf_seen !== undefined
        ? [
            // kill (real time) → wait → rm -rf result (real time) → wait → leak result
            { beat: "contain", from: "kill_seen+1.2", to: "rmrf_seen", fast: 1.2 },
            { beat: "contain", from: "rmrf_seen", to: "rmrf_seen+1.6", realtime: true },
            { beat: "contain", from: "rmrf_seen+1.6", to: "leak_seen", fast: 1.4 },
          ]
        : [{ beat: "contain", from: "kill_seen+1.4", to: "leak_seen", fast: 2.2 }]),
      { beat: "contain", from: "leak_seen", to: "contain_end", hold: marks.leak_bad_start !== undefined ? "contain_end" : "leak_seen+1.0", freeze: marks.leak_bad_start !== undefined },
      // a separately recorded Evaluation clip starts just before its dialog opens (its map is the base snapshot)
      { beat: "eval", from: evalClip ? "eval_open-0.5" : "eval_start", to: "eval_end", hold: "eval_open+1.2", src: evalClip ? 1 : 0 },
    ]
const BEATS = [...new Set(SEGS.map((s) => s.beat))]

// ---- resolve segments to frames (contiguous and non-overlapping within a beat)
SEGS.forEach((s, i) => {
  s.src = s.src ?? 0
  s.a = fr(at(s.from, s.src))
  const prev = SEGS[i - 1]
  if (prev && prev.beat === s.beat && prev.src === s.src && s.a < prev.b && !s.jump) s.a = prev.b
  s.b = Math.max(s.a, fr(at(s.to, s.src)))
})
for (const s of SEGS) {
  s.speed = 1
  if (s.fast !== undefined) {
    const len = T(s.b - s.a)
    if (len > (s.minWait ?? 1.0)) {
      s.speed = [2, 3, 4, 5, 6].find((k) => len / k <= s.fast) ?? 6
    }
  }
  if (s.speed > 1) s.b = s.a + Math.floor((s.b - s.a) / s.speed) * s.speed // whole output frames
  s.cut = s.b // may be trimmed for holds
  if (s.hold) s.min = Math.min(s.b, Math.max(s.a, fr(at(s.hold, s.src))))
  s.freezeF = 0
}

// ---- title card + narration placement
const chunksOut = []
const title = voice.beats.title
const t0 = P.titleLead
chunksOut.push({ beat: "title", i: 0, start: t0, ...title[0] })
let reveal, titleEnd
if (title.length > 1) {
  reveal = t0 + title[0].dur + P.titleGap - 0.15
  chunksOut.push({ beat: "title", i: 1, start: reveal + 0.15, ...title[1] })
  titleEnd = chunksOut[1].start + title[1].dur
} else {
  reveal = t0 + title[0].dur - 1.3 // "logless reads them so nobody has to." appears as the line ends
  titleEnd = Math.max(t0 + title[0].dur, reveal + 1.5)
}
const titleF = fr(titleEnd + P.titleTail)
let prevEnd = titleEnd
let tOut = T(titleF) // output clock (s)

const plan = []
for (const beat of BEATS) {
  const segs = SEGS.filter((s) => s.beat === beat)
  const hold = segs.find((s) => s.hold)
  if (hold) hold.cut = hold.min
  const beatStart = tOut
  // recording time → output time within this beat (the hold is last and may run past its current cut)
  const outOf = (rt) => {
    const f = fr(rt)
    let o = beatStart
    for (const s of segs) {
      if (f <= s.a) return o
      if (s === hold || f <= s.b) return o + T(Math.min(f, s.b) - s.a) / s.speed
      o += T(s.b - s.a) / s.speed
    }
    return o
  }
  let lastEnd = 0
  const bsrc = segs[0].src
  for (const [i, c] of (voice.beats[beat] ?? []).entries()) {
    if (c.requires && markSets[bsrc][c.requires] === undefined) continue
    const first = i === 0
    const start = Math.max(outOf(at(c.at, bsrc)), prevEnd + (first ? P.beatGap : voice.gap))
    chunksOut.push({ beat, i, start, ...c })
    prevEnd = lastEnd = start + c.dur
  }
  const natural = segs.reduce((a, s) => a + T((s === hold ? s.cut : s.b) - s.a) / s.speed, 0)
  const need = lastEnd + P.tailPad - beatStart
  if (hold && need > natural) {
    const extra = fr(need - natural)
    const room = hold.b - hold.cut
    hold.cut = Math.min(hold.b, hold.cut + extra)
    if (extra > room) {
      if (hold.freeze) hold.freezeF = extra - room // hold the final (real) frame
      else console.warn(`! ${beat}: narration runs ${T(extra - room).toFixed(2)} s past the recorded hold`)
    }
  }
  for (const s of segs) {
    const outLen = T((s === hold ? s.cut : s.b) - s.a) / s.speed + T(s.freezeF)
    plan.push({ beat, src: s.src, from: s.from, to: s.to, inA: T(s.a), inB: T(s === hold ? s.cut : s.b), speed: s.speed, freeze: +T(s.freezeF).toFixed(3), realtime: !!s.realtime, out: [tOut, tOut + outLen] })
    tOut += outLen
  }
}
const appEnd = tOut
const closeF = fr(P.closing)
const total = appEnd + T(closeF)

// ---- captions (hard cuts, never overlapping, never on the cards)
const caps = chunksOut.filter((c) => c.caption)
const captions = caps.map((c, k) => {
  const next = caps[k + 1]
  let end = c.start + c.dur + 0.35
  if (next && next.start - 0.03 < end) end = next.start - 0.03
  return { png: join(OV, `cap-${c.beat}-${c.i}.png`), text: c.caption, start: Math.max(T(titleF) + 0.05, c.start - 0.08), end: Math.min(end, appEnd - 0.3) }
})
const pills = plan
  .filter((p) => p.speed > 1)
  .map((p) => ({ png: join(OV, `speed-${p.speed}${p.beat === "intake" ? "-r" : ""}.png`), speed: p.speed, start: p.out[0], end: p.out[1] }))

// ---- ffmpeg inputs + graph
const sources = [join(WORK, "app.mp4"), ...(evalClip ? [join(WORK, "app_eval.mp4")] : [])]
const NS = sources.length
const inputs = [
  ...sources.map((f) => ["-i", f]),
  ["-loop", "1", "-framerate", String(FPS), "-i", join(OV, "title-a.png")],
  ["-loop", "1", "-framerate", String(FPS), "-i", join(OV, "title-b.png")],
  ["-loop", "1", "-framerate", String(FPS), "-i", join(OV, "closing.png")],
]
const g = []
const TD = T(titleF)
const W = "c=white"
g.push(`[${NS}:v]trim=end_frame=${titleF},setpts=N/(${FPS}*TB),format=rgba[ta]`)
g.push(`[${NS + 1}:v]trim=end_frame=${titleF},setpts=N/(${FPS}*TB),format=rgba,fade=in:st=${reveal.toFixed(3)}:d=0.35:alpha=1[tb]`)
g.push(`[ta][tb]overlay=shortest=1,format=yuv420p,setsar=1,fade=in:st=0:d=0.4:${W},fade=out:st=${(TD - 0.25).toFixed(3)}:d=0.25:${W}[title]`)
// consecutive segments from the same source form a group; groups are joined with a short white dip
const groups = []
plan.forEach((p, k) => {
  const a = fr(p.inA)
  const b = fr(p.inB)
  const sel = p.speed > 1 ? `,select='not(mod(n\\,${p.speed}))'` : ""
  const frz = p.freeze > 0 ? `,tpad=stop_mode=clone:stop=${Math.round(p.freeze * FPS)}` : ""
  g.push(`[${p.src}:v]trim=start_frame=${a}:end_frame=${b}${sel},setpts=N/(${FPS}*TB)${frz}[s${k}]`)
  if (!groups.length || groups.at(-1).src !== p.src) groups.push({ src: p.src, labels: [], start: p.out[0], end: p.out[1] })
  groups.at(-1).labels.push(`[s${k}]`)
  groups.at(-1).end = p.out[1]
})
groups.forEach((gr, i) => {
  const d = gr.end - gr.start
  g.push(`${gr.labels.join("")}concat=n=${gr.labels.length}:v=1:a=0,format=yuv420p,setsar=1,fade=in:st=0:d=0.25:${W},fade=out:st=${(d - 0.25).toFixed(3)}:d=0.25:${W}[app${i}]`)
})
g.push(`[${NS + 2}:v]trim=end_frame=${closeF},setpts=N/(${FPS}*TB),format=yuv420p,setsar=1,fade=in:st=0:d=0.35:${W}[close]`)
g.push(`[title]${groups.map((_, i) => `[app${i}]`).join("")}[close]concat=n=${groups.length + 2}:v=1:a=0[base]`)
let last = "base"
let idx = inputs.length
for (const [k, o] of [...captions, ...pills].entries()) {
  inputs.push(["-i", o.png])
  const lab = `o${k}`
  g.push(`[${last}][${idx}:v]overlay=0:0:enable='between(t\\,${o.start.toFixed(3)}\\,${o.end.toFixed(3)})'[${lab}]`)
  last = lab
  idx++
}
g.push(`[${last}]scale=out_range=tv:out_color_matrix=bt709,format=yuv420p[vout]`)
const aLabels = []
for (const c of chunksOut) {
  inputs.push(["-i", c.file])
  const ms = Math.round(c.start * 1000)
  g.push(`[${idx}:a]adelay=${ms}:all=1[a${idx}]`)
  aLabels.push(`[a${idx}]`)
  idx++
}
g.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:normalize=0:duration=longest,apad,atrim=end=${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`)

mkdirSync(join(WORK, "ff"), { recursive: true })
writeFileSync(join(WORK, "ff", "inputs.txt"), inputs.map((a) => a.join("\t")).join("\n") + "\n")
writeFileSync(join(WORK, "ff", "graph.txt"), g.join(";\n"))
writeFileSync(join(WORK, "ff", "total.txt"), total.toFixed(3))
const out = {
  total: +total.toFixed(3),
  title: { dur: TD, reveal },
  closing: { start: appEnd, dur: T(closeF) },
  segments: plan.map((p) => ({ ...p, inA: +p.inA.toFixed(3), inB: +p.inB.toFixed(3), out: p.out.map((x) => +x.toFixed(3)) })),
  narration: chunksOut.map((c) => ({ beat: c.beat, start: +c.start.toFixed(3), end: +(c.start + c.dur).toFixed(3), text: c.caption ?? c.spoken })),
  captions: captions.map((c) => ({ text: c.text, start: +c.start.toFixed(3), end: +c.end.toFixed(3) })),
  speed: pills.map((p) => ({ speed: p.speed, start: +p.start.toFixed(3), end: +p.end.toFixed(3) })),
  // [source, recording time]
  stills: dry
    ? { map: [0, at("map_badge+0.8")], eval: [0, at("eval_open+1.0")] }
    : {
        intake: [0, (at("intake_first") + at("intake_flight_end")) / 2],
        answer: [0, Math.min(at("ask_end"), at("ask_done+1.6"))],
        containment: [0, Math.min(at("contain_end"), at("leak_seen+1.0"))],
        eval: evalClip ? [1, at("eval_open+1.0", 1)] : [0, at("eval_open+1.0")],
      },
  override: override?.note ?? null,
}
writeFileSync(join(WORK, "timeline.json"), JSON.stringify(out, null, 1))

console.log(`title   0.00 – ${TD.toFixed(2)}`)
for (const b of BEATS) {
  const ps = plan.filter((p) => p.beat === b)
  const sp = ps.filter((p) => p.speed > 1).map((p) => `${p.from}→${p.to} ${(p.inB - p.inA).toFixed(1)}s@${p.speed}×`)
  console.log(`${b.padEnd(8)}${ps[0].out[0].toFixed(2).padStart(5)} – ${ps[ps.length - 1].out[1].toFixed(2).padStart(5)}  ${sp.join(", ")}`)
}
console.log(`closing ${appEnd.toFixed(2)} – ${total.toFixed(2)}`)
for (const c of out.narration) console.log(`   ${c.start.toFixed(2).padStart(6)} – ${c.end.toFixed(2).padStart(6)}  ${c.text}`)
console.log(`TOTAL ${total.toFixed(2)} s`)
if (total > P.maxTotal) {
  console.error(`total ${total.toFixed(2)} s exceeds ${P.maxTotal} s`)
  process.exit(4)
}
