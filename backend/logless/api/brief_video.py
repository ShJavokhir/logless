"""MP4 export of a video brief (docs/VIDEO_BRIEF.md).

The browser plays a brief instantly with the Remotion player; this renders the same
composition to an MP4 file people can download and share. The composition is our own
pre-built Remotion bundle and the brief is gated data (words checked, numbers filled by
code), so nothing model-written is executed. One render at a time, niced, with a hard
timeout; the file is written to a temp name and renamed only when complete.

Enabled when BRIEF_RENDER_SCRIPT (web/video-render/render.mjs) and BRIEF_RENDER_BUNDLE (a
`remotion bundle` output directory) exist; otherwise briefs are player-only."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..config import settings

log = logging.getLogger("logless.api")
BRIEF_ID = re.compile(r"^brf_[0-9a-f]{12}$")
TIMEOUT_S = 600

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="brief-render")
_lock = threading.Lock()
_state: dict[str, str] = {}   # brief_id -> "rendering" | "failed" (in-process only)


def _cfg() -> tuple[str, Path, Path] | None:
    script = os.environ.get("BRIEF_RENDER_SCRIPT", "")
    bundle = os.environ.get("BRIEF_RENDER_BUNDLE", "")
    if not script or not bundle or not Path(script).is_file() or not Path(bundle).is_dir():
        return None
    return os.environ.get("BRIEF_RENDER_NODE", "node"), Path(script), Path(bundle)


def enabled() -> bool:
    return _cfg() is not None


def video_dir() -> Path:
    return settings().data_dir / "briefs"


def video_path(brief_id: str) -> Path | None:
    if not BRIEF_ID.match(brief_id):
        return None
    p = video_dir() / f"{brief_id}.mp4"
    return p if p.is_file() else None


def status(brief_id: str) -> str:
    """ready | rendering | failed | unavailable"""
    if video_path(brief_id):
        return "ready"
    with _lock:
        st = _state.get(brief_id)
    if st:
        return st
    return "unavailable" if not enabled() else "none"


def ensure(brief: dict) -> str:
    """Queue an MP4 render for this brief unless it exists, is running, or failed before."""
    bid = brief.get("brief_id", "")
    if not BRIEF_ID.match(bid):
        return "unavailable"
    st = status(bid)
    if st != "none":
        return st
    with _lock:
        if bid in _state:
            return _state[bid]
        _state[bid] = "rendering"
    _pool.submit(_render, dict(brief))
    return "rendering"


def _render(brief: dict) -> None:
    bid = brief["brief_id"]
    cfg = _cfg()
    ok = False
    try:
        if cfg is None:
            return
        node, script, bundle = cfg
        out_dir = video_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        src = out_dir / f".{bid}.json"
        tmp = out_dir / f".{bid}.part.mp4"
        src.write_text(json.dumps(brief), encoding="utf-8")
        cmd = ["nice", "-n", "10", node, str(script), str(src), str(tmp), "--bundle", str(bundle),
               "--scale", "0.6667", "--concurrency", os.environ.get("BRIEF_RENDER_CONCURRENCY", "2")]
        # A minimal environment: the renderer never sees the service's provider keys.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("BRIEF_RENDER_HOME", str(script.parent)),
               "LANG": "C.UTF-8"}
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_S, cwd=str(script.parent), env=env)
        if p.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
            tmp.rename(out_dir / f"{bid}.mp4")
            ok = True
        else:
            log.error("brief render %s failed (exit %s): %s", bid, p.returncode, (p.stderr or "")[-400:])
    except subprocess.TimeoutExpired:
        log.error("brief render %s timed out", bid)
    except Exception as e:  # noqa: BLE001
        log.error("brief render %s crashed: %s", bid, type(e).__name__)
    finally:
        for f in (video_dir() / f".{bid}.json", video_dir() / f".{bid}.part.mp4"):
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass
        with _lock:
            if ok:
                _state.pop(bid, None)
            else:
                _state[bid] = "failed"
