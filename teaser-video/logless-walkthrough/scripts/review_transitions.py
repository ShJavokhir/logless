"""Sample the finished film using FFmpeg and Pillow; no Codex installation needed."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
RANGES = [
    ("opening", 2.3, 3.4),
    ("search", 4.3, 5.8),
    ("analysis", 8.25, 8.6),
    ("complete", 10.05, 10.4),
    ("inspect", 11.6, 12.6),
    ("action", 14.7, 15.6),
    ("loading", 16.5, 17.0),
    ("story", 18.2, 18.6),
    ("payoff", 21.2, 22.3),
    ("close", 26.5, 27.6),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, default=ROOT / "renders/complete-30s.mp4")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "review/regenerated-transitions")
    args = parser.parse_args()
    video = args.video.resolve()
    if not video.is_file():
        parser.error(f"Video does not exist: {video}")
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        parser.error("Install FFmpeg with ffprobe and make both available on PATH.")
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        parser.error("Install Pillow for this Python environment: python3 -m pip install Pillow")

    inventory = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(video)
    ], text=True))
    if float(inventory["format"]["duration"]) < max(end for _, _, end in RANGES):
        parser.error("The video is too short for the walkthrough's transition ranges.")

    # A fresh output directory keeps the original review evidence intact.
    output = args.output_dir.resolve()
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        parser.error("Output directory already exists; choose a new --output-dir.")
    (output / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")

    def sample(item):
        name, start, end = item
        directory = output / name
        frames = directory / "frames"
        frames.mkdir(parents=True)
        # Times are in seconds. Include both boundaries, at most 0.1 s apart.
        times = [round(start + n / 10, 3) for n in range(int(round((end - start) * 10)) + 1)]
        times = [time for time in times if time <= end]
        if times[-1] < end:
            times.append(end)
        sheet = Image.new("RGB", (4 * 480, ((len(times) + 3) // 4) * 302), "#fafafa")
        draw = ImageDraw.Draw(sheet)
        records = []
        for index, time in enumerate(times):
            path = frames / f"frame-{index + 1:03d}.png"
            subprocess.run([
                ffmpeg, "-nostdin", "-v", "error", "-ss", str(time), "-i", str(video),
                "-frames:v", "1", str(path)
            ], check=True)
            with Image.open(path) as image:
                thumbnail = image.convert("RGB")
                thumbnail.thumbnail((480, 270))
            x, y = (index % 4) * 480, (index // 4) * 302
            sheet.paste(thumbnail, (x, y))
            draw.text((x + 12, y + 279), f"{name} | {time:.3f} s", fill="#222222")
            records.append({"time_seconds": time, "frame": str(path.relative_to(output))})
        sheet.save(directory / "contact-sheet.jpg", quality=94)
        (directory / "samples.json").write_text(json.dumps(records, indent=2) + "\n")
        return {"transition": name, "samples": len(records)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        coverage = list(pool.map(sample, RANGES))
    (output / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    print(f"Saved {sum(item['samples'] for item in coverage)} frames across {len(coverage)} transitions to {output}")


if __name__ == "__main__":
    main()
