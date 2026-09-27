# Render and edit

This is an isolated Remotion project. Its package manifest and lockfile do not change the application dependency graph.

```sh
cd teaser-video/logless-walkthrough
npm ci
python3 scripts/soundtrack.py
npm run typecheck
npm run render
```

The local rendering run used the installed Chrome explicitly:

```sh
npm run render -- --browser-executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

Output: `renders/complete-30s.mp4`. Composition `Complete30`: 900 frames, 30 fps, 1920×1080, H.264, AAC, yuv420p, CRF 17. PNG intermediate frames preserve thin UI text before video encoding. scripts/render.mjs then copies the video stream and remuxes the original WAV to AAC with an exact 30-second container; no picture re-encode occurs. The frame range for the hardest early passage is 420–674 (14–22.5 seconds).

```sh
npm run passage -- --browser-executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npx remotion still src/index.ts Complete30 storyboard/payoff.png --frame=720
npm run studio
```

Edit camera, source-state and cursor timing in `src/timing.ts` and `src/Product.tsx`. Edit the separate editorial language in `src/Editorial.tsx`. The composition uses native system fonts; another operating system can produce different editorial font metrics. The UI PNGs retain their captured original fonts.

Do not replace the mock disclosure with a live claim. The screenshots demonstrate frontend mock behavior. They do not establish deployment, live inference, real records, privacy guarantees, or sandbox execution.

Capture provenance and sound rights: `assets.md`. Shot times and evidence: `storyboard.md`. Actual technical and visual checks: `review.md`.

To regenerate transition samples, install FFmpeg (including `ffprobe`) on your PATH and Pillow in your Python environment. No Codex skill or private runtime path is required:

```sh
python3 -m pip install Pillow
python3 scripts/review_transitions.py
```

The script creates `review/regenerated-transitions/` with native PNG samples, contact sheets, and JSON metadata. It refuses to overwrite an existing directory; use `--output-dir /path/to/a/new-directory` for later runs. These are newly sampled review artifacts, separate from the original delivery's evidence.

Remotion render flags were checked against the current [official CLI documentation](https://www.remotion.dev/docs/cli/render). Package versions are exactly pinned to 4.0.529. No browser is controlled for product capture by this project; the headless browser renders only the local composition.
