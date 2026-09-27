// Records one continuous take of the live logless app for the demo video.
//
// Capture: CDP Page.startScreencast (JPEG q92) instead of Playwright's recordVideo
// (which is capped at ~1 Mbit/s VP8). Every frame and every mark is stamped with
// the same Node clock (seconds since the first frame), so cuts in timeline.mjs line up.
//
// usage:  node record.mjs <workdir> [--dry | --reset-only]
//   env:  BASE_URL   (default https://144-202-110-2.sslip.io/)
//         DSF        device scale factor (default 4/3: renders supersampled; the screencast still
//                    delivers 1440×900 frames, which smooths text edges)
//         PLAYWRIGHT module path if `playwright` is not installed next to this file
//         ENV_FILE   where PRESENTER_KEY lives (default: repo-root .env)
// out:    <workdir>/rec/frames/NNNNN.jpg, frames.json, marks.json, facts.json
// --dry:        no paid/live step (no intake, question or containment): map + finding + evaluation
// --reset-only: just reset the live intake and confirm it is ready (no recording)
//
// Presenter key: read from .env, handed to the page through localStorage (the same
// place the app keeps it after `/?presenter=…`), so it never appears in a URL, a
// frame, a log line or a file. Every error message is scrubbed of it before printing.
//
// A take = one live intake + one question + one containment check. Waits are keyed
// to real UI states. A failed/paused step aborts the take (exit 2). The intake is
// reset after every take (and on abort), so the demo always starts clean.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const EVAL_ONLY = args.includes("--eval-only") // records only the Evaluation beat, into rec_eval/ (free)
const DRY = args.includes("--dry") || EVAL_ONLY
const RESET_ONLY = args.includes("--reset-only")
const WORK = args.find((a) => !a.startsWith("--")) ?? join(HERE, ".work")
const BASE = process.env.BASE_URL ?? "https://144-202-110-2.sslip.io/"
const DSF = +(process.env.DSF ?? 4 / 3)
const VW = 1440
const VH = 900
const EXPECT_BASE = process.env.EXPECT_BASE_SNAPSHOT ?? "snap_20260927T040954_6a04"

// ---- presenter key (never printed)
const envText = readFileSync(process.env.ENV_FILE ?? join(HERE, "..", ".env"), "utf8")
const KEY = envText.match(/^\s*PRESENTER_KEY\s*=\s*(.*)\s*$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
if (!KEY) {
  console.error("PRESENTER_KEY missing from .env")
  process.exit(3)
}
const scrub = (s) => String(s).split(KEY).join("[presenter-key]").split(encodeURIComponent(KEY)).join("[presenter-key]")
const log = (...a) => console.log(...a.map(scrub))
const warn = (...a) => console.warn(...a.map(scrub))
// any throw (a locator timeout, a closed page…) still records what it has and resets the intake
let crashing = false
const onFatal = async (e) => {
  if (crashing) return
  crashing = true
  console.error("fatal:", scrub(e?.stack ?? e))
  try {
    await abort(scrub(e?.message ?? e))
  } catch {
    if (!DRY && !RESET_ONLY) await resetIntake("after crash").catch(() => {})
    process.exit(1)
  }
}
process.on("uncaughtException", onFatal)
process.on("unhandledRejection", onFatal)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (path, init = {}) => {
  const r = await fetch(new URL(path, BASE), { ...init, headers: { "X-Logless-Presenter": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } })
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
}
const health = async () => (await api("api/health")).body ?? {}
const intakeStatus = async () => (await api("api/intake/status")).body ?? {}

/** Reset the intake and confirm: ready, base snapshot current, 5,050 conversations — and still so ~20 s later. */
async function resetIntake(reason) {
  for (let round = 1; round <= 3; round++) {
    log(`intake reset (${reason}${round > 1 ? `, round ${round}` : ""})`)
    let r = { status: 0 }
    for (let k = 0; k < 6; k++) {
      r = await api("api/intake/reset", { method: "POST", body: "{}" })
      if (r.status === 200) break
      warn(`  reset → ${r.status} ${r.body?.code ?? ""}; retrying`)
      await sleep(3000)
    }
    const check = async () => {
      const s = await intakeStatus()
      const h = await health()
      const snap = (await api("api/snapshot")).body
      return { ready: !!s.ready, batch: s.batch_size, base: s.base_snapshot_id, current: h.snapshot_id, conversations: snap?.dataset?.conversations, sandbox: h.sandbox }
    }
    let c
    for (let k = 0; k < 40; k++) {
      c = await check()
      if (c.ready && c.current === c.base) break
      await sleep(1000)
    }
    log("  after reset:", JSON.stringify(c))
    await sleep(20000) // a late publish from the run we just finished would land in this window
    const c2 = await check()
    log("  20 s later:", JSON.stringify(c2))
    const ok = c2.ready && c2.base === EXPECT_BASE && c2.current === EXPECT_BASE && c2.conversations === 5050
    if (ok) return { ok, status: c2 }
    warn("  not clean yet; resetting again")
  }
  return { ok: false }
}

if (RESET_ONLY) {
  const r = await resetIntake("--reset-only")
  process.exit(r.ok ? 0 : 1)
}

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright")
const voice = JSON.parse(readFileSync(join(WORK, "voice.json"), "utf8"))
const vdur = (beat, i) => voice.beats[beat][i].dur
const vsum = (beat) => voice.beats[beat].reduce((a, c) => a + c.dur, 0) + voice.gap * (voice.beats[beat].length - 1)

const REC = join(WORK, EVAL_ONLY ? "rec_eval" : "rec")
const FR = join(REC, "frames")
if (existsSync(REC)) rmSync(REC, { recursive: true })
mkdirSync(FR, { recursive: true })

let T0 = null
const now = () => (T0 === null ? 0 : (performance.now() - T0) / 1000)
const marks = {}
const mark = (name) => {
  marks[name] = +now().toFixed(3)
  log(`  ${marks[name].toFixed(2).padStart(6)}  ${name}`)
}

// ---- preflight (API side)
{
  const h = await health()
  let s = await intakeStatus()
  log("preflight", JSON.stringify(h), JSON.stringify(s))
  if (h.status !== "ok" || h.sandbox !== "reachable") {
    console.error("preflight failed: app not healthy — not recording")
    process.exit(3)
  }
  if (!DRY && (!s.ready || s.base_snapshot_id !== h.snapshot_id)) {
    const r = await resetIntake("not ready before the take")
    if (!r.status?.ready) process.exit(3)
  }
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
page.on("console", (m) => m.type() === "error" && consoleErrors.push(scrub(m.text())))
page.on("pageerror", (e) => consoleErrors.push(scrub(e.message)))
page.on("response", (r) => {
  if (r.status() >= 500) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${scrub(new URL(r.url()).pathname)} at ${now().toFixed(2)} s`)
})

// presenter capacity: store the key where the app keeps it, then load clean
await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.evaluate((k) => localStorage.setItem("logless.presenter", k), KEY)
await page.goto(BASE, { waitUntil: "networkidle" })
await page.waitForSelector("svg g[role=button]", { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
await sleep(1000)

// ---- preflight (screen side)
const pre = await page.evaluate(() => ({
  mock: /Mock API/.test(document.body.innerText),
  warn: /Live analysis unavailable|newer snapshot|Reset intake/i.test(document.body.innerText),
  evalBtn: [...document.querySelectorAll("footer button")].some((b) => /Evaluation/.test(b.textContent ?? "")),
  intakeBtn: [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Live intake"),
  url: location.href,
}))
log("screen preflight", JSON.stringify({ ...pre, url: pre.url.includes("presenter") ? "HAS PRESENTER PARAM" : "clean" }))
if (pre.mock || pre.warn || !pre.evalBtn || (!DRY && !pre.intakeBtn) || /presenter/.test(pre.url) || (await page.content()).includes(KEY)) {
  console.error("screen preflight failed — not recording")
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
const START = EVAL_ONLY ? { x: 1405, y: 470 } : { x: 1010, y: 700 }
await page.mouse.move(START.x, START.y) // first repaint → first frame
while (T0 === null) await sleep(10)

// ---- pointer helpers
let cur = { ...START }
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
  await loc.waitFor({ state: "visible", timeout: 20000 })
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
async function finish(code, msg) {
  await cdp.send("Page.stopScreencast").catch(() => {})
  await sleep(200)
  mark("end")
  writeFileSync(join(REC, "frames.json"), JSON.stringify(frames))
  writeFileSync(join(REC, "marks.json"), JSON.stringify({ dry: DRY, dsf: DSF, viewport: [VW, VH], base: BASE, recorded_at: new Date().toISOString(), aborted: msg ?? null, marks }, null, 1))
  writeFileSync(join(REC, "facts.json"), JSON.stringify(facts, null, 1))
  log("facts", JSON.stringify(facts))
  log(`${frames.length} frames over ${now().toFixed(1)} s`)
  log(consoleErrors.length ? "console errors:\n" + consoleErrors.join("\n") : "no console errors")
  await browser.close()
  if (!DRY) {
    const r = await resetIntake(msg ? "after aborted take" : "after take")
    facts.reset = r
    writeFileSync(join(REC, "facts.json"), JSON.stringify(facts, null, 1))
    if (!r.ok) warn("! intake reset not confirmed")
  }
  process.exit(code)
}
async function abort(msg) {
  console.error(`ABORT: ${scrub(msg)}`)
  await finish(2, msg)
}

// facts read off the screen during the take; voice.mjs fills {placeholders} in the
// narration from these, and mismatches with the script's claims are flagged.
const facts = {}
const expect = (name, ok, got) => {
  facts.checks = facts.checks ?? {}
  facts.checks[name] = { ok, got }
  if (!ok) warn(`! narration fact "${name}" not on screen (got: ${got})`)
}
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => "")) ?? ""
const aside = 'aside[aria-label="Details"]'

if (EVAL_ONLY) {
  await sleep(600)
} else {
// ================================================================ beat: map
await sleep(400)
mark("map_start")
{
  const hdr = await text("header")
  expect("header: 5,000 WildChat conversations", /5,000 WildChat/.test(hdr), hdr.match(/[\d,]+ conversations[^·]*/)?.[0])
  const m = await page.evaluate(() => document.body.innerText.match(/(\d+) workflows · (\d+) categories/)?.slice(1))
  facts.workflows = m?.[0]
}
await sleep(500)
// the provenance tooltip: "computed by the logless pipeline on Vultr from 5,000 real conversations … No one can open a conversation here."
await glideTo(page.getByRole("button", { name: "Aggregate insights only" }), 1300, -20, 2)
mark("map_badge")
await sleep((vsum("map") + 1.5) * 1000)
mark("map_end")

// ================================================================ beat: live intake
mark("intake_start")
if (!DRY) {
  await glideTo(page.getByRole("button", { name: "Live intake", exact: true }), 900)
  await click(150)
  mark("intake_click")
  await glide(866, 205, 700) // park at the map's right edge: hovers no circle, clear of the dots
  const panel = 'section[aria-labelledby="intake-h"]'
  const read = () =>
    page.evaluate((sel) => {
      const t = document.querySelector(sel)?.innerText ?? ""
      const m = t.match(/([\d,]+)\s*\/\s*([\d,]+)\s*conversations decided/)
      return {
        decided: m ? +m[1].replace(/,/g, "") : 0,
        total: m ? +m[2].replace(/,/g, "") : 0,
        rate: t.match(/(\d+)\s*conv\/s/)?.[1] ?? null,
        p50: t.match(/([\d,]+)\s*ms p50/)?.[1] ?? null,
        // "Map updated …" needs the run summary (GET /api/runs/{id}); the header's
        // "Published" badge only needs the new snapshot to have swapped in
        published: /Map updated/.test(t) || /Published/.test(document.querySelector(`${sel} header`)?.textContent ?? ""),
        summary: /Map updated/.test(t),
        // only the panel's own "Failed" badge ends a take; a transient alert (a poll that
        // hiccuped and is being retried) is logged, not treated as a failure
        failed: /Failed/.test(document.querySelector(`${sel} header`)?.textContent ?? ""),
        alert: document.querySelector(`${sel} [role=alert]`)?.textContent ?? null,
        text: t,
      }
    }, panel)
  await waitState((sel) => {
    const t = document.querySelector(sel)?.innerText ?? ""
    return /[1-9][\d,]*\s*\/\s*[\d,]+\s*conversations decided/.test(t) || /Failed/.test(document.querySelector(`${sel} header`)?.textContent ?? "")
  }, panel, 60000)
  if ((await read()).failed) await abort("intake failed to start: " + (await read()).text.slice(0, 200))
  mark("intake_first")
  let st
  let lastAlert = null
  let maxRate = 0
  const tStart = performance.now()
  for (;;) {
    st = await read()
    if (st.rate) maxRate = Math.max(maxRate, +st.rate)
    if (st.failed) await abort("intake failed: " + st.text.slice(0, 600))
    if (st.alert && st.alert !== lastAlert) {
      warn(`! intake panel alert at ${now().toFixed(2)} s: ${st.alert}`)
      facts.intake_alerts = [...(facts.intake_alerts ?? []), { t: +now().toFixed(2), text: st.alert }]
    }
    lastAlert = st.alert
    if (st.total && st.decided >= st.total && !marks.intake_decided) mark("intake_decided")
    if (st.published) break
    if (performance.now() - tStart > 120000) await abort("intake did not publish within 120 s")
    await sleep(50)
  }
  mark("intake_published")
  if (!st.summary) {
    // give the completion summary a moment (it arrives with the run record)
    await waitState((sel) => /Map updated/.test(document.querySelector(sel)?.innerText ?? ""), panel, 4000).catch(() => warn("! no \"Map updated\" summary in the panel (run record unavailable?)"))
  }
  // the dots keep landing for a moment after the last decision; the map swaps once they all land
  marks.intake_flight_end = +Math.min(marks.intake_published, (marks.intake_decided ?? marks.intake_published) + 1.6).toFixed(3)
  facts.intake = { decided: st.decided, total: st.total, rate_final: st.rate, rate_max: maxRate, p50_ms: st.p50 }
  facts.rate = String(Math.round(+(st.rate ?? maxRate) / 10) * 10)
  expect("intake: 300 decided", st.decided === 300 && st.total === 300, `${st.decided}/${st.total}`)
  await page.locator("[data-sonner-toast]").filter({ hasText: "Map updated" }).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => warn("! no completion toast"))
  mark("intake_toast")
  facts.toast = (await text("[data-sonner-toast]")).replace(/\s+/g, " ").trim()
  facts.header_after = (await text("header")).match(/[\d,]+ conversations[^·]*/)?.[0]
  await sleep((vdur("intake", 2) + 2.5) * 1000)
  mark("intake_end")
}

// ================================================================ beat: key finding → where it breaks
mark("finding_start")
if (!DRY) {
  await glideTo(page.getByRole("button", { name: "Close live intake" }), 750)
  await click(100)
}
const finding = page.locator('section[aria-labelledby="finding-h"]')
await finding.waitFor({ state: "visible", timeout: 15000 })
mark("finding_card")
{
  const t = (await finding.innerText()).replace(/\s+/g, " ")
  facts.finding = t.slice(0, 220)
  const m = t.match(/is ([\d.]+)% of conversations but ([\d.]+)% of observed friction/)
  expect("finding: coding under a fifth of conversations, over a quarter of friction", !!m && +m[1] < 20 && +m[2] > 25, m?.[0])
  const hot = t.match(/Show where it breaks\s*→?\s*([^·]+?)\s*·\s*([\d.]+)% friction/)
  facts.hot = hot ? `${hot[1].trim()} · ${hot[2]}%` : null
}
// rest on the button while the finding is read out, then open where it breaks
await glideTo(finding.getByRole("button", { name: /Show where it breaks/ }), 800)
await sleep(Math.max(600, (0.9 + vdur("finding", 0) - 1.4 - (now() - marks.finding_start)) * 1000))
await click(100)
mark("finding_click")
await sleep(1500)
mark("finding_end")
} // !EVAL_ONLY

// ================================================================ beat: ask a question
const answer = 'section[aria-labelledby="answer-h"]'
const Q = "Which coding workflows have the most distinct people repeating requests?"
facts.retries = []

/** One attempt: returns true when Verified. Marks are (re)set per attempt, so a failed
 *  first attempt falls outside the cut; any retry is recorded in facts.retries. */
async function askOnce() {
  mark("ask_start")
  await glideTo(page.getByRole("button", { name: "Ask a question", exact: true }).first(), 850)
  await click(110)
  const chip = page.locator(answer).getByRole("button", { name: Q })
  await chip.waitFor({ state: "visible", timeout: 10000 })
  await sleep(250)
  mark("ask_open")
  await glideTo(chip, 700, -120, 0)
  await click(150)
  mark("ask_click")
  await sleep(150)
  await glide(1414, 330, 600) // park at the card's edge so the loop strip stays readable
  await waitState((sel) => /interpreted as/i.test(document.querySelector(sel)?.innerText ?? "") || /Failed|Paused|Not answerable/.test(document.querySelector(`${sel} header`)?.textContent ?? ""), answer, 90000)
  mark("ask_plan")
  await waitState((sel) => /Verified|Failed|Paused|Not answerable/.test(document.querySelector(`${sel} header`)?.textContent ?? ""), answer, 180000)
  const chipText = (await text(`${answer} header`)).replace(/\s+/g, " ")
  if (!/Verified/.test(chipText)) {
    const why = `${chipText} · ${(await text(answer)).replace(/\s+/g, " ").slice(0, 400)}`
    warn(`! question did not verify: ${why}`)
    facts.retries.push({ step: "question", at: now(), why })
    return false
  }
  mark("ask_done")
  return true
}

/** One containment attempt from the sheet; true when both phases passed. */
async function containOnce(scrollTo, again) {
  mark("contain_start")
  if (!again) {
    await scrollTo("#containment", 700)
    mark("contain_scroll")
    await sleep(100)
  }
  const runBtn = page.getByRole("button", { name: again ? "Run again" : "Run containment check" })
  await glideTo(runBtn, 500)
  await click(130)
  mark("contain_click")
  await sleep(180)
  await glide(1405, 470, 450) // out of the way of the result
  const bad = async (why) => {
    warn(`! containment: ${why}`)
    facts.retries.push({ step: "containment", at: now(), why })
    return false
  }
  await waitState(() => /Runaway program running|Execution limit reached|could not start/i.test(document.getElementById("containment")?.textContent ?? "") || !!document.querySelector("#containment [role=alert]"), null, 60000)
  if (await page.locator("#containment [role=alert]").count()) return bad("could not start: " + (await page.locator("#containment [role=alert]").innerText()))
  mark("runaway_seen")
  await waitState(() => /Execution limit reached/.test(document.getElementById("containment")?.textContent ?? ""), null, 60000)
  mark("kill_seen")
  // phase 2: `rm -rf --no-preserve-root /` against the read-only root (stage "destructive")
  await waitState(() => /Destructive command (absorbed|NOT contained)/.test(document.getElementById("containment")?.textContent ?? "") || /Leak attempt (rejected|was NOT)/.test(document.getElementById("containment")?.textContent ?? "") || /Run again/.test(document.querySelector("#containment button")?.textContent ?? ""), null, 90000)
  {
    const t = await page.locator("#containment").innerText()
    if (/Destructive command NOT contained/.test(t)) return bad("destructive command NOT contained")
    if (/Destructive command absorbed/.test(t)) mark("rmrf_seen")
    else warn("! no destructive-command card before the leak result")
  }
  await waitState(() => /Leak attempt (rejected|was NOT)/.test(document.getElementById("containment")?.textContent ?? "") || /Run again/.test(document.querySelector("#containment button")?.textContent ?? ""), null, 90000)
  const ctext = await page.locator("#containment").innerText()
  writeFileSync(join(REC, "containment.txt"), ctext)
  if (!/Leak attempt rejected by the gate/.test(ctext)) return bad("leak attempt not rejected / check incomplete: " + ctext.replace(/\s+/g, " ").slice(0, 300))
  mark("leak_seen")
  facts.kill_ms = ctext.match(/([\d,]+) ms\s*\n?\s*measured/)?.[1]
  facts.rmrf = { exit: ctext.match(/exit (\d+) · ([\d,]+) deletions refused/)?.slice(1), absorbed: /Destructive command absorbed/.test(ctext), checks: ctext.split("\n").filter((l) => /Read-only filesystem|Container destroyed|Next run clean/.test(l)) }
  expect("rm -rf: absorbed, read-only, container destroyed", /Destructive command absorbed/.test(ctext) && /Read-only filesystem · nothing deleted/.test(ctext) && /Container destroyed/.test(ctext), facts.rmrf.checks.join(" | "))
  return true
}

if (!DRY) {
  if (!(await askOnce())) {
    await glideTo(page.getByRole("button", { name: "Close answer" }), 600)
    await click(100)
    await sleep(600)
    if (!(await askOnce())) await abort("question failed twice")
  }
  const at = (await text(answer)).replace(/\s+/g, " ")
  facts.answer = { chip: (await text(`${answer} header`)).match(/Verified · [\d.]+ s/)?.[0], text: at.slice(0, 600) }
  expect("answer: two programs agree", /programs agree/i.test(at), at.match(/programs (agree|differ)/i)?.[0])
  await sleep(600)
  // point at the verified rows
  await glideTo(page.locator(answer).getByText(/verified rows/i).first(), 700, 0, 26).catch(() => {})
  await sleep((vsum("ask") + 1.5) * 1000)
  mark("ask_end")

  // ============================================================== beat: run details (both programs, cross-checks)
  mark("details_start")
  await glideTo(page.locator(answer).getByRole("button", { name: "Run details" }), 750)
  await click(100)
  await page.getByRole("heading", { name: "Run details" }).waitFor({ state: "visible" })
  await sleep(350)
  mark("sheet_open")
  const body = page.locator("[data-slot=sheet-content] .overflow-y-auto").first()
  const scrollTo = async (sel, ms, pad = 10) => {
    const bb = await body.boundingBox()
    const tb = await page.locator(sel).first().boundingBox()
    const room = await body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    const d = Math.min(room, tb.y - bb.y - pad)
    if (Math.abs(d) > 4) await wheel(d, ms)
  }
  await glide(771, 560, 300) // the sheet body's left padding: wheel scrolls the sheet, not the code block
  await scrollTo('section[aria-labelledby="rd-programs"]', 600)
  mark("details_programs")
  facts.programs = (await text('section[aria-labelledby="rd-programs"]')).replace(/\s+/g, " ").slice(0, 160)
  await sleep(1150)
  await scrollTo('section[aria-labelledby="rd-cross"]', 500)
  mark("details_cross")
  facts.cross = (await text('section[aria-labelledby="rd-cross"]')).replace(/\s+/g, " ").slice(0, 300)
  expect("run details: programs agree", /programs agree|Two independent programs agree/i.test(facts.cross), facts.cross.slice(0, 80))
  await sleep(2200)
  mark("details_end")

  // ============================================================== beat: containment
  if (!(await containOnce(scrollTo, false))) {
    await sleep(800)
    if (!(await containOnce(scrollTo, true))) await abort("containment check failed twice")
  }
  // off-camera (trimmed hold): let the post-intake evaluation report land before opening it
  const tWait = performance.now()
  for (;;) {
    const e = await api("api/eval")
    const h = await health()
    if (e.status === 200 && e.body?.snapshot_id === h.snapshot_id) break
    if (performance.now() - tWait > 90000) {
      warn(`! evaluation report for ${h.snapshot_id} not ready (last: ${e.status} ${e.body?.snapshot_id ?? e.body?.code})`)
      break
    }
    await sleep(1000)
  }
  await sleep(Math.max(0, (vsum("contain") + 2.0) * 1000 - (performance.now() - tWait)))
  mark("contain_end")
}

// ================================================================ beat: evaluation
mark("eval_start")
if (!DRY) {
  await page.keyboard.press("Escape")
  await sleep(350)
}
await glideTo(page.getByRole("button", { name: "Evaluation" }), 800)
await click(120)
await page.getByRole("dialog").getByText(/targets met/).waitFor({ state: "visible", timeout: 20000 })
await sleep(300)
mark("eval_open")
{
  const t = await page.getByRole("dialog").innerText()
  const m = t.match(/(\d+) of (\d+) targets met/)
  facts.targets = m ? `${m[1]} of ${m[2]}` : null
  facts.eval_snapshot = t.match(/snap_\w+/)?.[0]
  expect("eval: 0 detected canary leaks", /0 detected canary leaks/.test(t), t.match(/\d+ detected canary leaks/)?.[0])
  if (!m) warn("! could not read the evaluation target count")
}
await glide(700, 222, 800) // rest beside "0 detected canary leaks"
await sleep((vsum("eval") + 2.0) * 1000)
mark("eval_end")
await sleep(300)
await finish(0)
