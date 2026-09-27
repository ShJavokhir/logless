// Renders the title/closing cards and the caption + speed overlays as PNGs (1440×900).
// Cards use the app's own look: light background, Geist / Geist Mono, lots of whitespace.
// usage: node render.mjs <workdir>   → <workdir>/overlays/*.png
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = process.argv[2] ?? join(HERE, ".work")
const OUT = join(WORK, "overlays")
mkdirSync(OUT, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright")
const voice = JSON.parse(readFileSync(join(WORK, "voice.json"), "utf8"))
// fonts inlined as data: URLs (file:// fonts are blocked for setContent pages)
const font = (f) => `data:font/woff2;base64,${readFileSync(join(HERE, "assets", "fonts", f)).toString("base64")}`

const W = 1440
const H = 900
const css = `
@font-face { font-family: Geist; src: url(${font("geist-latin-wght-normal.woff2")}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Geist Mono"; src: url(${font("geist-mono-latin-wght-normal.woff2")}) format("woff2"); font-weight: 100 900; }
:root {
  --bg: oklch(0.982 0.0018 95); --fg: oklch(0.2 0.006 285); --muted: oklch(0.49 0.01 285);
  --subtle: oklch(0.62 0.008 285); --border: oklch(0.91 0.0035 95); --card: oklch(1 0 0);
  --brand: oklch(0.5 0.105 255); --heat: oklch(0.56 0.14 36); --ok: oklch(0.52 0.1 155);
}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${W}px; height: ${H}px; }
body { font-family: Geist, system-ui, sans-serif; color: var(--fg); -webkit-font-smoothing: antialiased; }
.mono { font-family: "Geist Mono", ui-monospace, monospace; }
`
const logo = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="currentColor"/><circle cx="13" cy="17" r="7" fill="none" stroke="var(--bg)" stroke-width="2.2"/><circle cx="21.5" cy="12" r="4" fill="var(--bg)"/></svg>`
const wordmark = (s, t) => `<span style="display:inline-flex;align-items:center;gap:${s * 0.42}px;color:var(--fg)">${logo(s)}<span class="mono" style="font-size:${t}px;font-weight:600;letter-spacing:-0.03em;line-height:1">logless</span></span>`

const cardShell = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { background: var(--bg); }
.frame { position: absolute; inset: 0; padding: 112px 128px; display: flex; flex-direction: column; }
.meta { font-size: 15px; color: var(--subtle); letter-spacing: 0.01em; }
</style></head><body><div class="frame">${inner}</div></body></html>`

const title = (reveal) =>
  cardShell(`
  <div>${wordmark(30, 23)}</div>
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center;max-width:1080px;padding-bottom:24px">
    <h1 style="font-size:58px;line-height:1.1;font-weight:600;letter-spacing:-0.028em">
      Users tell you what’s broken every day —<br>but you can’t read their conversations.
    </h1>
    <p style="margin-top:34px;font-size:58px;line-height:1.1;font-weight:600;letter-spacing:-0.028em;color:var(--brand);visibility:${reveal ? "visible" : "hidden"}">
      logless reads them so nobody has to.
    </p>
  </div>
  <div class="meta mono">Vultr Agent Arena · Track 1: Agent Sandboxing</div>`)

const chip = (label, sub) =>
  `<div style="border:1px solid var(--border);background:var(--card);border-radius:14px;padding:16px 20px;min-width:0">
     <div style="font-size:19px;font-weight:600;letter-spacing:-0.01em">${label}</div>
     <div style="margin-top:4px;font-size:15px;color:var(--muted)">${sub}</div></div>`
const closing = cardShell(`
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center">
    <div>${wordmark(56, 44)}</div>
    <p style="margin-top:26px;font-size:34px;line-height:1.2;font-weight:500;letter-spacing:-0.02em;color:var(--fg)">What people do with your assistant, and what isn’t working —<br>without anyone reading a conversation.</p>
    <div style="margin-top:52px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1000px">
      ${chip("GLM", "on Vultr Serverless Inference")}
      ${chip("Jev", "by TypeSafe")}
      ${chip("gVisor sandbox", "on Vultr")}
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <div class="meta mono" style="color:var(--muted);font-size:17px">144-202-110-2.sslip.io</div>
    <div class="meta mono">Vultr Agent Arena · Track 1: Agent Sandboxing</div>
  </div>`)

const overlayShell = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { background: transparent; }
/* centred on screen, narrow enough to clear the bottom-left toast */
.cap { position: absolute; left: 720px; bottom: 28px; transform: translateX(-50%); max-width: 660px; width: max-content;
  padding: 10px 20px 11px; border-radius: 12px; background: rgb(22 22 26 / 0.84); color: #fff;
  font-size: 22px; line-height: 1.34; font-weight: 500; letter-spacing: -0.005em; text-align: center; text-wrap: balance;
  box-shadow: 0 6px 24px -8px rgb(0 0 0 / 0.35); }
.pill.r { left: auto; right: 583px; top: 148px; }
.pill { position: absolute; left: 32px; top: 142px; display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 13px 7px 11px; border-radius: 999px; background: rgb(22 22 26 / 0.84); color: #fff; font-size: 15px; font-weight: 600; }
</style></head><body>${inner}</body></html>`
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
async function shot(html, file, transparent = false) {
  await page.setContent(html, { waitUntil: "load" })
  const ok = await page.evaluate(async () => {
    const a = await document.fonts.load('600 20px Geist')
    const b = await document.fonts.load('600 20px "Geist Mono"')
    await document.fonts.ready
    return a.length > 0 && b.length > 0
  })
  if (!ok) throw new Error("Geist fonts did not load")
  await page.screenshot({ path: join(OUT, file), omitBackground: transparent })
}

await shot(title(false), "title-a.png")
await shot(title(true), "title-b.png")
await shot(closing, "closing.png")
for (const [beat, chunks] of Object.entries(voice.beats)) {
  for (const [i, c] of chunks.entries()) {
    if (c.caption) await shot(overlayShell(`<div class="cap">${esc(c.caption)}</div>`), `cap-${beat}-${i}.png`, true)
  }
}
const ff = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3 5.5v13l9-6.5zM12.5 5.5v13l9-6.5z"/></svg>`
// two placements: top-left of the map (default) and top-right of the map (-r), used
// during live intake where the "New conversations" inbox badge sits top-left
for (const s of ["2", "3", "4", "5", "6"]) {
  await shot(overlayShell(`<div class="pill">${ff}<span>${s}× speed</span></div>`), `speed-${s}.png`, true)
  await shot(overlayShell(`<div class="pill r">${ff}<span>${s}× speed</span></div>`), `speed-${s}-r.png`, true)
}
await browser.close()
console.log("overlays →", OUT)
