"""Human-readable summary of a published snapshot (public fields only + gate counts + timings).
Written to backend/logless/eval/last_build_summary.md after every publish."""
from __future__ import annotations

from pathlib import Path

from ..pipeline import util

SUMMARY_PATH = Path(__file__).resolve().parent / "last_build_summary.md"


def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.1f}%"


def render(snap: dict, build: util.Build | None = None) -> str:
    t = snap["totals"]
    lines = [f"# logless build summary — {snap['snapshot_id']}", "",
             f"- Workspace: {snap['workspace']['name']}",
             f"- Dataset: {snap['dataset']['name']} @ {snap['dataset']['revision'][:8]}, {snap['dataset']['period_start']} → "
             f"{snap['dataset']['period_end']}; {snap['dataset']['conversations']:,} conversations, "
             f"{snap['dataset']['users']:,} people, {snap['dataset']['languages']} languages; fixtures "
             f"{snap['dataset']['fixtures']}",
             f"- Totals: friction {_pct(t['friction']['share'])} ({t['friction']['conversations']}), unclear "
             f"{t['friction']['unclear']}; signals {t['friction']['signals']}",
             f"- Stats source: {snap['provenance'].get('stats_source')}; discovery rounds "
             f"{snap['provenance']['discovery_rounds']}; build {snap['provenance']['build_seconds']} s; dataset hash "
             f"{snap['provenance']['dataset_hash']}", ""]
    leaves = {l["id"]: l for l in snap["clusters"]}
    lines.append("## Taxonomy")
    lines.append("")
    for c in snap["categories"]:
        lines.append(f"### {c['title']} [{c.get('short_title', '')}] — {c['conversations']:,} conv · {c['users']:,} people · share {_pct(c['share'])} · "
                     f"friction {_pct(c['friction']['share'])}")
        lines.append(f"_{c['description']}_")
        lines.append("")
        lines.append("| Leaf | Short | Conv | People | Share | Friction | corr | repeat | limit | complaint | Surprising |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
        for lid in c["children"]:
            l = leaves[lid]
            s = l["friction"]["signals"]
            sur = l.get("surprising")
            sur_s = "—" if not sur else (f"**{sur['score']:.2f} flagged**" if sur["flag"] else f"{sur['score']:.2f}")
            lines.append(f"| {l['title']} | {l.get('short_title', '')} | {l['conversations']} | {l['users']} | {_pct(l['share'])} | "
                         f"{_pct(l['friction']['share'])} | {s['correction']} | {s['repeat_request']} | "
                         f"{s['assistant_limit']} | {s['complaint']} | {sur_s} |")
        lines.append("")
    lines.append("## Leaf texts")
    lines.append("")
    for l in sorted(snap["clusters"], key=lambda x: -x["conversations"]):
        lines.append(f"**{l['title']}** (`{l['id']}`) — {l['description']}")
        for n in l.get("needs", []):
            lines.append(f"- need {n['id']}: {n['text']}")
        for p in l.get("problems", []):
            lines.append(f"- problem {p['id']} [{p['signal'] or 'none'}, {p['support']}]: {p['text']}")
        lines.append("")
    if build is not None:
        gate = build.info.get("gate", {})
        lines.append("## Privacy gate")
        lines.append("")
        for k, v in gate.items():
            lines.append(f"- {k}: {v}")
        lines.append("")
        lines.append("## Stage timings (s)")
        lines.append("")
        for k, v in build.info.get("stage_seconds", {}).items():
            lines.append(f"- {k}: {v}")
        lines.append("")
        from ..pipeline.run import build_usage
        usage = build_usage(build)
        if usage:
            lines.append("## Model usage for this build (cached calls cost nothing; Jev/Fireworks tokens estimated from payload size)")
            lines.append("")
            lines.append("| Stage | Provider | Model | Calls | Cached | Prompt tok | Completion tok | USD |")
            lines.append("|---|---|---|---:|---:|---:|---:|---:|")
            for u in usage:
                est = " (est.)" if u["estimated"] else ""
                lines.append(f"| {u['stage']} | {u['provider']} | {u['model']} | {u['calls']} | {u['cached']} | "
                             f"{u['prompt_tokens']}{est} | {u['completion_tokens']}{est} | "
                             f"{'—' if u['usd'] is None else u['usd']} |")
            lines.append("")
    return "\n".join(lines)


def write_summary(snap: dict, build: util.Build | None = None, path: Path = SUMMARY_PATH) -> Path:
    path.write_text(render(snap, build))
    return path
