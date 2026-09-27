// Records one continuous take of the live logless app for the demo video.
//
// Capture: CDP Page.startScreencast (JPEG q92) instead of Playwright's recordVideo
// (which is capped at ~1 Mbit/s VP8). Every frame and every mark is stamped with
// the same Node clock (seconds since the first frame), so cuts in build.sh line up.
//
// usage:  node record.mjs <workdir> [--dry]
//   env:  BASE_URL   (default https://144-202-110-2.sslip.io/)
//         DSF        device scale factor (default 1.3333333 → 1920×1200 frames from a 1440×900 viewport)
//         PLAYWRIGHT module path if `playwright` is not installed next to this file
// out:    <workdir>/rec/frames/NNNNN.jpg, <workdir>/rec/frames.json, <workdir>/rec/marks.json
// --dry:  skips every paid live step (analysis run, story, containment): map + evaluation only.
//
// Waits are keyed to real UI states (Verified chip, story card, containment
// results). A failed/paused live step aborts the take (exit 2) instead of being
// shown; re-run the script (each take costs one analysis, one story, one containment).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const DRY = args.includes("--dry")
const WORK = args.find((a) => !a.startsWith("--")) ?? join(HERE, ".work")
const BASE = process.env.BASE_URL ?? "https://144-202-110-2.sslip.io/"
const DSF = +(process.env.DSF ?? 4 / 3)
const VW = 1440
const VH = 900
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright")

const voice = JSON.parse(readFileSync(join(WORK, "voice.json"), "utf8"))
const vdur = (beat, i) => voice.beats[beat][i].dur
const vsum = (beat) => voice.beats[beat].reduce((a, c) => a + c.dur, 0) + voice.gap * (voice.beats[beat].length - 1)

const REC = join(WORK, "rec")
const FR = join(REC, "frames")
if (existsSync(REC)) rmSync(REC, { recursive: true })
mkdirSync(FR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let T0 = null
const now = () => (T0 === null ? 0 : (performance.now() - T0) / 1000)
const marks = {}
const mark = (name) => {
  marks[name] = +now().toFixed(3)
  console.log(`  ${marks[name].toFixed(2).padStart(6)}  ${name}`)
}
const holdUntil = async (t) => {
  const ms = (t - now()) * 1000
  if (ms > 0) await sleep(ms)
}

const browser = await chromium.launch({ args: ["--force-color-profile=srgb", "--hide-scrollbars"] })
const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, colorScheme: "light", reducedMotion: "no-preference" })

// Pointer overlay: headless Chromium draws no cursor. Pure decoration that follows real
// input events (pointer-events: none, attached to <html> so it sits above Radix portals).
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return
    const c = document.createElement("div")
    c.id = "__demo_cursor"
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-80px,-80px);will-change:transform"
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26" style="display:block;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / .35))"><path d="M4 2.5 L4 20.5 L8.6 16.3 L11.6 23 L14.8 21.6 L11.9 15 L18.3 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    document.documentElement.appendChild(c)
    const ringStyle = "position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:999px;border:2px solid rgb(59 110 190 / .75);background:rgb(59 110 190 / .12);transition:transform .45s cubic-bezier(.2,.7,.3,1),opacity .45s ease-out"
    addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2.5}px)`), true)
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div")
        r.style.cssText = ringStyle + `;left:${e.clientX}px;top:${e.clientY}px;transform:scale(.35);opacity:1`
        document.documentElement.appendChild(r)
        requestAnimationFrame(() => requestAnimationFrame(() => ((r.style.transform = "scale(1.15)"), (r.style.opacity = "0"))))
        setTimeout(() => r.remove(), 600)
      },
      true,
    )
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install)
  else install()
})

const page = await context.newPage()
const consoleErrors = []
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()))
page.on("pageerror", (e) => consoleErrors.push(e.message))

await page.goto(BASE, { waitUntil: "networkidle" })
await page.waitForSelector("svg g[role=button]", { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
await sleep(800)

// ---- preflight: real API, sandbox reachable, no warnings on screen
const pre = await page.evaluate(() => ({
  mock: /Mock API/.test(document.body.innerText),
  warn: /Live analysis unavailable|newer snapshot/i.test(document.body.innerText),
  evalBtn: [...document.querySelectorAll("footer button")].some((b) => /Evaluation/.test(b.textContent ?? "")),
}))
let health = {}
for (let k = 0; k < 4; k++) {
  const r = await page.request.get(new URL("api/health", BASE).toString())
  health = await r.json().catch(() => ({ http: r.status() }))
  if (health.sandbox) break
  await sleep(1500)
}
console.log("preflight", JSON.stringify(pre), JSON.stringify(health))
if (pre.mock || pre.warn || !pre.evalBtn || health.sandbox !== "reachable") {
  console.error("preflight failed — not recording")
  await browser.close()
  process.exit(3)
}

// ---- capture
const cdp = await context.newCDPSession(page)
const frames = []
let frameNo = 0
cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
  if (T0 === null) T0 = performance.now()
  const t = now()
  const file = `${String(frameNo++).padStart(5, "0")}.jpg`
  writeFileSync(join(FR, file), Buffer.from(data, "base64"))
  frames.push({ file, t: +t.toFixed(4) })
  try {
    await cdp.send("Page.screencastFrameAck", { sessionId })
  } catch {}
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(VW * DSF), maxHeight: Math.round(VH * DSF), everyNthFrame: 1 })
await page.mouse.move(1010, 760) // first repaint → first frame
while (T0 === null) await sleep(10)

// ---- pointer helpers
let cur = { x: 1010, y: 760 }
await page.mouse.move(cur.x, cur.y)
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
// time-based easing: duration is the same whatever the per-event CDP overhead is
async function glide(x, y, ms = 800) {
  const { x: sx, y: sy } = cur
  const bend = Math.min(40, Math.hypot(x - sx, y - sy) * 0.08) // slight arc, like a hand
  const t0 = performance.now()
  for (;;) {
    const p = Math.min(1, (performance.now() - t0) / ms)
    const e = ease(p)
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e - Math.sin(Math.PI * e) * bend)
    if (p >= 1) break
    await sleep(12)
  }
  cur = { x, y }
}
async function center(loc) {
  await loc.waitFor({ state: "visible", timeout: 15000 })
  const b = await loc.boundingBox()
  if (!b) throw new Error("no bounding box")
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }
}
async function glideTo(loc, ms = 800, dx = 0, dy = 0) {
  const c = await center(loc)
  await glide(c.x + dx, c.y + dy, ms)
  return c
}
async function click(pause = 120) {
  await sleep(pause)
  await page.mouse.down()
  await sleep(70)
  await page.mouse.up()
}
async function wheel(dy, ms = 700) {
  const t0 = performance.now()
  let done = 0
  for (;;) {
    const p = Math.min(1, (performance.now() - t0) / ms)
    const target = Math.round(dy * ease(p))
    if (target !== done) await page.mouse.wheel(0, target - done)
    done = target
    if (p >= 1) break
    await sleep(16)
  }
}
const waitState = (fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { polling: "raf", timeout })
async function abort(msg) {
  console.error(`ABORT: ${msg}`)
  await cdp.send("Page.stopScreencast").catch(() => {})
  writeFileSync(join(REC, "marks.json"), JSON.stringify({ aborted: msg, marks }, null, 1))
  await browser.close()
  process.exit(2)
}

const circle = (prefix) => page.locator(`svg g[role=button][aria-label^="${prefix}"]`).first()
const gap = voice.gap

// ================================================================ beat: map
await sleep(400)
mark("map_start")
await sleep(900)
await glideTo(circle("Learn and get explanations"), 1300, 10, 30)
// arrive on "Probing the AI" as the second map line starts
await holdUntil(marks.map_start + 0.2 + vdur("map", 0) + gap - 1.0)
await glideTo(circle("Probe and test the assistant"), 1000, 6, 30)
mark("map_probe")
await sleep((vdur("map", 1) + 1.2) * 1000)
mark("map_end")

// ================================================================ beat: live run
mark("run_start")
if (!DRY) {
  const ask = page.getByRole("button", { name: "What's not working?" })
  await glideTo(ask, 850)
  await click(150)
  mark("run_click")
  await waitState(() => /Verified|Failed|Paused/.test(document.querySelector('[aria-labelledby="answer-h"] header')?.textContent ?? ""), null, 120000)
  const chip = await page.locator('[aria-labelledby="answer-h"] header').innerText()
  if (!/Verified/.test(chip)) await abort(`analysis run did not verify: ${chip.replace(/\s+/g, " ")}`)
  mark("run_verified")
  await sleep(500)
  // rest on the hottest software workflow: tooltip shows its friction share on the lens
  await glideTo(circle("Diagnose and fix technical errors"), 1000, 24, 16) // lower right of the circle, so its 39.5% label stays visible
  mark("run_lens")
  await sleep((vdur("run", 1) + vdur("run", 2) + 3.0) * 1000)
  mark("run_end")

  // ============================================================== beat: workflow + story
  mark("story_start")
  await click(80) // select "Fixing errors" (the pointer is already on it)
  await sleep(200)
  await glideTo(page.getByRole("button", { name: "Collapse answer" }), 620)
  await click(90)
  await sleep(250)
  await glide(1150, 600, 420)
  mark("story_detail")
  await sleep(900)
  // scroll the detail panel down to the story button
  const panel = page.locator("aside [class*='overflow-y-auto']").last()
  const gen = page.getByRole("button", { name: "Generate fictional user story" })
  await gen.waitFor({ state: "attached" })
  {
    const pb = await panel.boundingBox()
    const bb = await gen.boundingBox()
    const room = await panel.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    const need = Math.min(room, bb.y + bb.height - (pb.y + pb.height - 150))
    if (need > 4) await wheel(need, 700)
    await sleep(80)
  }
  await glideTo(gen, 520)
  await click(110)
  mark("story_click")
  await waitState(() => !!document.getElementById("story-card-h") || !!document.querySelector('[aria-labelledby="story-h"] [role=alert]'), null, 120000)
  if (!(await page.locator("#story-card-h").count())) await abort("story failed: " + (await page.locator('[aria-labelledby="story-h"]').innerText()))
  mark("story_ready")
  await sleep(200)
  await glide(1414, 470, 320) // park the pointer at the panel edge, off the text
  {
    const card = page.locator('section[aria-labelledby="story-card-h"]')
    const pb = await panel.boundingBox()
    const cb = await card.boundingBox()
    const room = await panel.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    const need = Math.min(room, cb.y + cb.height - (pb.y + pb.height - 64))
    if (need > 4) await wheel(need, 800)
  }
  await sleep((vdur("story", 1) + 3.0) * 1000)
  mark("story_end")

  // ============================================================== beat: run details + containment
  mark("contain_start")
  await glideTo(page.getByRole("button", { name: "Expand answer" }), 650)
  await click(90)
  await sleep(250)
  await glideTo(page.getByRole("button", { name: "Run details" }), 620)
  await click(90)
  await page.getByRole("heading", { name: "Run details" }).waitFor({ state: "visible" })
  await sleep(350)
  mark("sheet_open")
  const body = page.locator("[data-slot=sheet-content] .overflow-y-auto").first()
  const scrollTo = async (sel, ms) => {
    const bb = await body.boundingBox()
    const tb = await page.locator(sel).first().boundingBox()
    const d = tb.y - bb.y - 10
    if (Math.abs(d) > 4) await wheel(d, ms)
  }
  await glide(771, 560, 320) // pointer in the sheet body's left padding (wheel target; not over the code block, which scrolls on its own)
  await scrollTo('section[aria-labelledby="rd-receipt"]', 550) // receipt (runsc, limits) + gate checklist
  mark("sheet_receipt")
  await sleep(1600)
  await scrollTo("#containment", 650)
  mark("contain_scroll")
  await sleep(80)
  const runBtn = page.getByRole("button", { name: "Run containment check" })
  await glideTo(runBtn, 480)
  await click(130)
  mark("contain_click")
  await sleep(180)
  await glide(1405, 470, 450) // out of the way of the result
  await waitState(() => /Runaway program running|Execution limit reached|could not start/i.test(document.getElementById("containment")?.textContent ?? "") || !!document.querySelector("#containment [role=alert]"), null, 60000)
  if (await page.locator("#containment [role=alert]").count()) await abort("containment could not start: " + (await page.locator("#containment [role=alert]").innerText()))
  mark("runaway_seen")
  await waitState(() => /Execution limit reached/.test(document.getElementById("containment")?.textContent ?? ""), null, 60000)
  mark("kill_seen")
  await waitState(() => /Leak attempt (rejected|was NOT)/.test(document.getElementById("containment")?.textContent ?? ""), null, 90000)
  mark("leak_seen")
  const ctext = await page.locator("#containment").innerText()
  if (!/Leak attempt rejected by the gate/.test(ctext)) await abort("leak attempt was not rejected")
  await sleep((vdur("contain", voice.beats.contain.length - 1) + 2.5) * 1000)
  mark("contain_end")
  writeFileSync(join(REC, "containment.txt"), ctext)
}

// ================================================================ beat: evaluation
mark("eval_start")
if (!DRY) {
  await page.keyboard.press("Escape")
  await sleep(350)
}
await glideTo(page.getByRole("button", { name: "Evaluation" }), 800)
await click(120)
await page.getByRole("dialog").getByText(/targets met/).waitFor({ state: "visible" })
await sleep(300)
mark("eval_open")
await glide(700, 222, 800) // rest beside "0 detected canary leaks"
await sleep((vdur("eval", 0) + 2.5) * 1000)
mark("eval_end")

await sleep(300)
await cdp.send("Page.stopScreencast")
await sleep(200)
mark("end")
writeFileSync(join(REC, "frames.json"), JSON.stringify(frames))
writeFileSync(join(REC, "marks.json"), JSON.stringify({ dry: DRY, dsf: DSF, viewport: [VW, VH], base: BASE, recorded_at: new Date().toISOString(), marks }, null, 1))
console.log(`${frames.length} frames over ${now().toFixed(1)} s (${(frames.length / now()).toFixed(1)} fps avg)`)
console.log(consoleErrors.length ? "console errors:\n" + consoleErrors.join("\n") : "no console errors")
await browser.close()
