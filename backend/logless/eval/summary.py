"""Human-readable summary of a published snapshot (public fields only + gate counts + timings).
Written to backend/logless/eval/last_build_summary.md after every publish."""
from __future__ import annotations

from pathlib import Path

from ..pipeline import util

SUMMARY_PATH = Path(__file__).resolve().parent / "last_build_summary.md"


def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.1f}%"


def _check(report: dict | None, cid: str) -> dict | None:
    return next((c for c in (report or {}).get("checks", []) if c["id"] == cid), None)


def known_limitations(snap: dict, build: util.Build | None, report: dict | None) -> list[str]:
    """Public-safe limitations with the numbers that back them (aggregates only)."""
    lines = ["## Known limitations", ""]
    d1 = build.load("discover_r1", {}) if build is not None and build.has("discover_r1") else {}
    k = str(d1.get("k", ""))
    diag = d1.get("diagnostics", {}).get(k, {})
    sil = _check(report, "silhouette")
    emb = "Facet embeddings form a continuum rather than separated clusters"
    if diag:
        emb += (f": k-means at k={k} has a two-seed adjusted Rand index of {diag['ari_two_seeds']:.2f} and a silhouette of "
                f"{diag['silhouette']:.3f} on the capped subset")
    if sil:
        emb += f"; the silhouette of the published leaf assignment is {sil['value']}"
    lines.append(f"- {emb}. Leaves are therefore defined by their names and includes/excludes notes, and membership "
                 "relies on Jev classifying the full conversation text, not on embedding distance.")
    china = next((l for l in snap["clusters"] if "china" in (l["title"] + " " + l.get("short_title", "")).lower()), None)
    if china:
        zh = next((x["conversations"] for x in china["languages"] if x["name"] == "Chinese"), 0)
        lines.append(f"- \"{china['title']}\" is topic-named and behaves partly like a Chinese-language bucket ({zh} of its "
                     f"{china['conversations']} conversations are in Chinese); both Opus labelling batches noted ties "
                     "between it and goal-named leaves.")
    tiny = [l for l in snap["clusters"] if not l.get("is_other") and l["conversations"] < 10]
    if tiny:
        lines.append("- Tiny leaves are published without a size threshold (by design; wording is generalized instead): "
                     + "; ".join(f"{l['title']} ({l['conversations']} conversations, {l['users']} people)" for l in tiny) + ".")
    lines.append("- `assistant_limit` mixes capability limits (no browsing, no images, no memory, output length) with "
                 "policy refusals; the published problems say which, but the count does not separate them.")
    lines.append("- \"People\" are distinct hashed IP addresses: shared or changing addresses (proxies, campuses) merge "
                 "or split real people, so people counts are approximate.")
    corr = _check(report, "friction_correction")
    cut = "Friction decisions below 0.65 top probability are stored as unclear, trading recall for precision"
    if corr:
        cut += f" (correction: {corr['detail'].split(' Support:')[0].rstrip('.')})"
    lines.append(f"- {cut}.")
    other = next((l for l in snap["clusters"] if l.get("is_other")), None)
    if other:
        lines.append(f"- {other['conversations']} conversations ({100 * other['share']:.1f}%) stay in Other or unclear after "
                     f"{snap['provenance']['discovery_rounds']} discovery rounds.")
    lines.append("")
    return lines


def eval_section(report: dict) -> list[str]:
    scored = [c for c in report["checks"] if c["passed"] is not None]
    met = sum(1 for c in scored if c["passed"])
    lines = [f"## Evaluation ({met} of {len(scored)} targets met)", "",
             "| Check | Value | Target | Result |", "|---|---|---|---|"]
    for c in report["checks"]:
        res = {True: "met", False: "NOT met", None: "info"}[c["passed"]]
        lines.append(f"| {c['name']} | {c['value']} | {c['target']} | {res} |")
    lines.append("")
    return lines


def render(snap: dict, build: util.Build | None = None, report: dict | None = None) -> str:
    t = snap["totals"]
    lines = [f"# logless build summary — {snap['snapshot_id']}", "",
             f"- Workspace: {snap['workspace']['name']}",
             f"- Dataset: {snap['dataset']['name']} @ {snap['dataset']['revision'][:8]}, {snap['dataset']['period_start']} → "
             f"{snap['dataset']['period_end']}; {snap['dataset']['conversations']:,} conversations, "
             f"{snap['dataset']['users']:,} people, {snap['dataset']['languages']} languages; fixtures "
             f"{snap['dataset']['fixtures']}",
             f"- Totals: friction {_pct(t['friction']['share'])} ({t['friction']['conversations']}), unclear "
             f"{t['friction']['unclear']}; signals {t['friction']['signals']}",
             f"- Counts, people and friction metrics computed in: {snap['provenance'].get('stats_source')} "
             f"(languages per node: backend); discovery rounds "
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
    lines += known_limitations(snap, build, report)
    if report is not None:
        lines += eval_section(report)
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


def write_summary(snap: dict, build: util.Build | None = None, report: dict | None = None, path: Path | None = None) -> Path:
    path = path or SUMMARY_PATH
    path.write_text(render(snap, build, report))
    return path
