"""Operator CLI: `logless seed | rebuild | eval | serve` (there is no admin screen)."""
from __future__ import annotations

import argparse
import logging
import sys


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="logless")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("seed", help="download the pinned WildChat shard, sample it, add evaluation fixtures")
    s.add_argument("--n", type=int, default=None)
    s.add_argument("--seed", type=int, default=None)

    imp = sub.add_parser("import", help="import text conversation JSONL into an empty private data directory")
    imp.add_argument("path", help="JSONL conversations (see docs/DATA_IMPORT.md)")
    imp.add_argument("--metadata", required=True, help="public source/workspace metadata JSON")
    imp.add_argument("--data-dir", required=True, help="new empty directory; use it for subsequent rebuild/eval/serve")

    r = sub.add_parser("rebuild", help="run the pipeline and publish a snapshot atomically")
    r.add_argument("--limit", type=int, default=None, help="only use the first N sampled conversations (pilot)")
    r.add_argument("--from-stage", default=None)
    r.add_argument("--no-cache", action="store_true", help="fresh model/embedding calls (ignore cached responses)")

    sub.add_parser("eval", help="compute the evaluation report for the current snapshot")

    stp = sub.add_parser("subthemes", help="sub-cluster each published leaf theme and store titled sub-themes")
    stp.add_argument("--build", required=True, help="build id whose published snapshot gets sub-themes")
    stp.add_argument("--members-only", action="store_true",
                     help="no model calls: re-derive and store which conversation is in which stored sub-theme "
                          "(for sub-themes published before membership was kept; needed for live questions)")

    it = sub.add_parser("intake", help="live intake batch (docs/CONTRACTS.md §11)")
    itsub = it.add_subparsers(dest="intake_cmd", required=True)
    ip = itsub.add_parser("prepare", help="pick N new shard conversations and extract their facets now")
    ip.add_argument("--n", type=int, default=300)
    ip.add_argument("--seed", type=int, default=None)
    itsub.add_parser("status", help="show the prepared batch")
    itsub.add_parser("reset", help="re-publish the base snapshot and clear the batch's decisions")

    sy = sub.add_parser("synth", help="write a synthetic corpus from the known mix in eval/synthetic_mix.json (calls GLM)")
    sy.add_argument("--n", type=int, default=5000)
    sy.add_argument("--out", required=True, help="new directory for conversations.jsonl, source.json and truth.jsonl")
    sy.add_argument("--seed", type=int, default=7)
    rc = sub.add_parser("reconstruct", help="score the current build against a synthetic truth.jsonl")
    rc.add_argument("truth", help="truth.jsonl written by `synth`")
    rc.add_argument("--build", default=None, help="build id (default: the current snapshot's build)")

    sv = sub.add_parser("serve", help="run the API server")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.cmd == "import":
        import json
        import os
        from pathlib import Path
        from .config import settings
        from .data.importer import ImportError, load_jsonl
        os.environ["LOGLESS_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())
        settings.cache_clear()
        try:
            result = load_jsonl(Path(args.path).expanduser(), Path(args.metadata).expanduser())
        except (ImportError, OSError) as e:
            # Filesystem errors carry operator file paths but no private conversation values.
            p.error(str(e))
        print(json.dumps(result))
        return 0

    if args.cmd == "seed":
        from .data import wildchat
        n = wildchat.load_sample(args.n, args.seed)
        try:
            from .data import fixtures  # added by the pipeline build
            n += fixtures.plant()
        except ImportError:
            logging.getLogger("logless").warning("evaluation fixtures module not available yet")
        print(f"seeded {n} conversations")
        return 0
    if args.cmd == "rebuild":
        from .pipeline import run as pipeline_run
        return pipeline_run.main(limit=args.limit, from_stage=args.from_stage, no_cache=args.no_cache)
    if args.cmd == "intake":
        import json as _json
        from . import intake
        logging.getLogger("httpx").setLevel(logging.WARNING)
        if args.intake_cmd == "prepare":
            out = intake.prepare(args.n, args.seed)
            out.pop("usage", None)
        elif args.intake_cmd == "status":
            out = {**intake.status(), "batch": intake.current_batch()}
        else:
            out = intake.reset()
        print(_json.dumps(out, indent=1))
        return 0
    if args.cmd == "subthemes":
        import json as _json
        from .pipeline import subthemes
        out = subthemes.backfill_members(args.build) if args.members_only else subthemes.run(args.build)
        print(_json.dumps(out, indent=1))
        return 0
    if args.cmd == "eval":
        from .eval import report
        return report.main()
    if args.cmd in ("synth", "reconstruct"):
        import json as _json
        from pathlib import Path
        from .eval import reconstruct
        logging.getLogger("httpx").setLevel(logging.WARNING)
        if args.cmd == "synth":
            out = reconstruct.synth(args.n, Path(args.out).expanduser(), args.seed)
        else:
            out = reconstruct.score(Path(args.truth).expanduser(), args.build or reconstruct.current_build())
        print(_json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    if args.cmd == "serve":
        import uvicorn
        uvicorn.run("logless.api.app:app", host=args.host, port=args.port, log_level="info", access_log=False)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
