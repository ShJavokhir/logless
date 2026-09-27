#!/usr/bin/env bash
# Builds the logless one-minute demo video.
#
#   ./build.sh            reuse the last recording in $WORK/rec (re-cut, re-voice, re-encode)
#   ./build.sh --record   record a new live take first (costs 1 analysis + 1 story + 1 containment run)
#   ./build.sh --dry      record a free take (map + evaluation only) to test the pipeline
#
# env: WORK        work dir for frames/intermediates (default: demo/.work)
#      PLAYWRIGHT  path to playwright's index.mjs if it is not installed in demo/ (pnpm install)
#      BASE_URL    app to record (default https://144-202-110-2.sslip.io/)
#
# out: demo/logless-demo.mp4 (H.264 + AAC, captions burned in), demo/logless-demo-silent.mp4,
#      demo/frame-*.png, $WORK/timeline.json (the cut plan)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.work}"
mkdir -p "$WORK"
cd "$HERE"

RECORD=0; DRY=""
for a in "$@"; do
  case "$a" in
    --record) RECORD=1 ;;
    --dry) RECORD=1; DRY="--dry" ;;
    *) echo "unknown arg $a" >&2; exit 1 ;;
  esac
done

echo "== narration (macOS say)"
node voice.mjs "$WORK"

if [[ $RECORD == 1 || ! -f "$WORK/rec/marks.json" ]]; then
  echo "== recording ${DRY:-live}"
  node record.mjs "$WORK" $DRY
  echo "== narration again, with the numbers read off the screen during the take"
  node voice.mjs "$WORK"
fi

echo "== cards + captions"
node render.mjs "$WORK"

echo "== frames → app.mp4 (30 fps CFR, near-lossless 4:4:4 intermediate)"
node -e '
const fs = require("fs"), path = require("path")
const rec = path.join(process.argv[1], "rec")
const frames = JSON.parse(fs.readFileSync(path.join(rec, "frames.json")))
const { marks } = JSON.parse(fs.readFileSync(path.join(rec, "marks.json")))
const end = marks.end ?? frames.at(-1).t + 1
let s = "ffconcat version 1.0\n"
frames.forEach((f, i) => {
  const d = (i + 1 < frames.length ? frames[i + 1].t : end) - f.t
  s += `file frames/${f.file}\nduration ${Math.max(d, 0.001).toFixed(4)}\n`
})
s += `file frames/${frames.at(-1).file}\n`
fs.writeFileSync(path.join(rec, "frames.ffconcat"), s)
' "$WORK"
ffmpeg -y -v error -f concat -safe 0 -i "$WORK/rec/frames.ffconcat" \
  -vf "fps=30,scale=1440:900:flags=lanczos:in_range=pc:out_range=tv,setsar=1" -fps_mode cfr -color_range tv \
  -c:v libx264 -preset medium -crf 8 -pix_fmt yuv444p "$WORK/app.mp4"

echo "== timeline"
node timeline.mjs "$WORK"
TOTAL="$(cat "$WORK/ff/total.txt")"

echo "== final encode (${TOTAL}s)"
ARGS=()
while IFS=$'\t' read -r -a parts; do ARGS+=("${parts[@]}"); done < "$WORK/ff/inputs.txt"
ffmpeg -y -v error "${ARGS[@]}" -/filter_complex "$WORK/ff/graph.txt" \
  -map "[vout]" -map "[aout]" -t "$TOTAL" \
  -c:v libx264 -preset slow -crf 17 -profile:v high -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -r 30 -g 60 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart "$HERE/logless-demo.mp4"
ffmpeg -y -v error -i "$HERE/logless-demo.mp4" -map 0:v -c copy -an -movflags +faststart "$HERE/logless-demo-silent.mp4"

echo "== stills (clean app frames, no captions)"
rm -f "$HERE"/frame-*.png
node -e '
const t = JSON.parse(require("fs").readFileSync(process.argv[1] + "/timeline.json"))
Object.entries(t.stills).forEach(([k, v], i) => console.log(`${i + 1}-${k} ${v.toFixed(3)}`))
' "$WORK" | while read -r name ts; do
  ffmpeg -y -v error -ss "$ts" -i "$WORK/app.mp4" -frames:v 1 -update 1 "$HERE/frame-$name.png" </dev/null
done

echo "== check"
for f in logless-demo.mp4 logless-demo-silent.mp4; do
  printf '%-26s ' "$f"
  ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,pix_fmt,r_frame_rate -of compact=p=0:nk=1 "$HERE/$f" | tr '\n' ' '
  echo
done
ls -la "$HERE"/logless-demo*.mp4 "$HERE"/frame-*.png
