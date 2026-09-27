"""Operator-only live benchmark. Never generates or replicates benchmark inputs.

python -m logless.eval.classify_benchmark --help
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from .. import db
from ..config import settings
from ..pipeline.fast_classify import Options, Summary, classify_prepared, encode, prepare, strict_json


def load_inputs(summary_path: Path, taxonomy_path: Path, label_path: Path):
    rows = [strict_json(line) for line in summary_path.read_text().splitlines() if line.strip()]
    if any(not isinstance(r, dict) or set(r) != {"summary_id", "summary"} for r in rows):
        raise ValueError("summary records require only summary_id and summary")
    summaries = [Summary(**r) for r in rows]
    taxonomy = strict_json(taxonomy_path.read_text())
    if not isinstance(taxonomy, list) or any(not isinstance(t, dict) or not {"theme_id", "name"} <= set(t)
                                           or set(t) - {"theme_id", "name", "description", "includes", "excludes"}
                                           for t in taxonomy):
        raise ValueError("taxonomy must be a list of frozen theme definitions")
    labels = strict_json(label_path.read_text())
    if not isinstance(labels, dict) or not labels or any(not isinstance(v, str) for v in labels.values()):
        raise ValueError("labels must map summary IDs to frozen theme IDs (or other)")
    return summaries, taxonomy, labels


def compact(report: dict) -> dict:
    """No summaries, taxonomy text, per-item predictions, or source IDs on stdout."""
    return {k: v for k, v in report.items() if k != "attempts"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summaries", type=Path, required=True)
    parser.add_argument("--taxonomy", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True, help="isolated private benchmark directory")
    parser.add_argument("--env-file", type=Path, help="optional explicit credential file; never logged")
    parser.add_argument("--batch-sizes", default="32,128")
    parser.add_argument("--concurrency", type=int, default=24)
    parser.add_argument("--min-accuracy", type=float, default=0.90)
    parser.add_argument("--max-accuracy-drop", type=float, default=0.02)
    parser.add_argument("--pilot-only", action="store_true", help="compare on the labeled subset; no 10k claim")
    args = parser.parse_args(argv)
    if not (0 <= args.min_accuracy <= 1 and 0 <= args.max_accuracy_drop <= 1):
        parser.error("accuracy limits must be in [0,1]")
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file, override=False)
    os.environ["LOGLESS_DATA_DIR"] = str(args.data_dir.resolve())
    settings.cache_clear()
    if settings().private_db.exists():
        parser.error("use a new private benchmark data directory")
    summaries, themes, labels = load_inputs(args.summaries, args.taxonomy, args.labels)
    if not args.pilot_only and len(summaries) != 10_000:
        parser.error("full benchmark requires exactly 10,000 prepared summaries; no replication")
    if not args.pilot_only and len(labels) < 100:
        parser.error("full benchmark requires at least 100 independently labeled examples")
    if len({s.summary for s in summaries}) != len(summaries):
        parser.error("benchmark requires distinct summaries; duplicate content needs a separately audited dataset")
    if not set(labels) <= {s.summary_id for s in summaries}:
        parser.error("labels contain unknown input IDs")
    pilot = [s for s in summaries if s.summary_id in labels]
    sizes = sorted(set(int(n) for n in args.batch_sizes.split(",")))
    if any(n < 2 for n in sizes):
        parser.error("batch sizes must be at least 2")
    # Validate the entire workload before the pilot spends tokens.
    for size in sizes:
        prepare(summaries, themes, Options(batch_size=size), "preflight")
    runs = []
    for layout, size in [("single", 1), *(("shared", n) for n in sizes)]:
        result = classify_prepared(pilot, themes, labels=labels,
                                   options=Options(layout=layout, batch_size=size, concurrency=args.concurrency))
        runs.append((size, result))
        print(json.dumps({"phase": "paired_pilot", **compact(result)}), flush=True)
        if result["status"] == "failed":
            return 1
        # Independent runs get separate event loops and rate gates. Clear the
        # previous token window and request spacing outside the measured interval.
        time.sleep(1)
    baseline = runs[0][1]["accuracy"]["value"]
    eligible = [(n, r) for n, r in runs if r["status"] == "complete"
                and r["accuracy"]["value"] >= args.min_accuracy
                and r["accuracy"]["value"] >= baseline - args.max_accuracy_drop]
    if not eligible:
        print(json.dumps({"status": "quality_gate_failed", "target_met": False}))
        return 1
    selected_size, selected = min(eligible, key=lambda item: item[1]["end_to_end_s"])
    con = db.private()
    baseline_predictions = dict(con.execute("SELECT conv_id,theme_id FROM assignments WHERE build_id=?",
                                           (runs[0][1]["run_id"],)).fetchall())
    chosen_predictions = dict(con.execute("SELECT conv_id,theme_id FROM assignments WHERE build_id=?",
                                         (selected["run_id"],)).fetchall())
    comparison = {"selected_batch_size": selected_size, "pilot_runs": [r["run_id"] for _, r in runs],
                  "min_accuracy": args.min_accuracy, "max_accuracy_drop": args.max_accuracy_drop,
                  "paired_agreement": sum(chosen_predictions[k] == v for k, v in baseline_predictions.items()) / len(pilot),
                  "labeled_sample_size": len(pilot), "target_met": False}
    if not args.pilot_only:
        # Context packing always uses the conservative byte bound. Rate pacing
        # uses measured pilot usage plus 25% headroom, then corrects upward live.
        ratio = min(1.0, 1.25 * max(a["usage"]["input_tokens"] / a["input_token_bound"]
                                   for a in selected["attempts"] if a.get("usage")))
        result = classify_prepared(summaries, themes, labels=labels,
                                   options=Options(layout=selected["layout"], batch_size=selected_size,
                                                   concurrency=args.concurrency, token_rate_ratio=ratio))
        quality = result.get("accuracy", {}).get("value", -1) >= max(args.min_accuracy, baseline - args.max_accuracy_drop)
        comparison.update(full_run=compact(result), target_met=bool(result.get("latency_target_met") and quality))
    report_path = args.data_dir / "comparison.json"
    report_path.write_bytes(encode(comparison))
    report_path.chmod(0o600)
    print(json.dumps(comparison), flush=True)
    return 0 if args.pilot_only or comparison["target_met"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
