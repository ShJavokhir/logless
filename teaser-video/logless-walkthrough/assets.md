# Asset and capture ledger

All seven source PNGs are untouched 1440×900 captures of the local frontend from main agent's browser session. Captured on 2026-09-26, device scale 1. The final source refresh includes #404040 chart values and the panel-only story scroll. Original location: /Users/ohong/dev/logless/frontend-evidence/screenshots/. The capture source is a locally running Next.js frontend using its explicit mock adapter. The main agent owns browser verification.

| Local asset in captures/ and public/ | Film time | Actual state |
| --- | --- | --- |
| 01-overview.png | 0–5.76s | Populated usage map, 600 conversations |
| 02-search.png | 5.6–8.51s | Coordinating query, matching aggregate clusters |
| 03-analysis-running.png | 8.35–10.31s | Friction view, analysis running, simulated |
| 04-friction.png | 10.15–12.36s | Simulated analysis complete, 46/108 friction |
| 05-inspect.png | 12.2–16.86s | Selected changing-plans detail and story action |
| 06-story-loading.png | 16.7–18.46s | Actual loading state with simulated label |
| 07-fictional-story.png | 18.3–27.4s | Actual authored fictional story, panel-only scroll |

No UI reconstruction is used. Native screenshot pixels are cropped and uniformly scaled. State transitions use brief crossfades between actual captures. Cursor graphics illustrate the measured observed controls. Brand and all large outside-frame language are editorial graphics. The constant disclosure is editorial and supplements the captured disclosure when framing crops it.

## Sound

- Title/creator: logless quiet-keys bed and UI cues, original programmatic composition authored for this film.
- Source: scripts/soundtrack.py. Deterministic sine-based additive synthesis; no samples, downloads, melodies from references, APIs, or third-party recordings.
- File: public/soundtrack.wav, stereo 48kHz PCM16, 30 seconds.
- Rights: original generated production asset. No third-party attribution or sampled recording rights.
- Use: entire film, with three soft taps aligned to cursor intentions and one result cue.
- Cost: $0. No paid asset or metered integration.
- Review: technical loudness, duration, clipping, and decode checks; listening is not available to this agent.

## Typography and references

Native -apple-system / BlinkMacSystemFont / Segoe UI / sans-serif stack. No Apple font is downloaded or bundled. Reference films remain outside this project and are not composited into the output. Remotion runtime and rendering version is pinned to 4.0.529 in the package lock.
