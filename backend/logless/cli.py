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

    r = sub.add_parser("rebuild", help="run the pipeline and publish a snapshot atomically")
    r.add_argument("--limit", type=int, default=None, help="only use the first N sampled conversations (pilot)")
    r.add_argument("--from-stage", default=None)

    sub.add_parser("eval", help="compute the evaluation report for the current snapshot")

    sv = sub.add_parser("serve", help="run the API server")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

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
        return pipeline_run.main(limit=args.limit, from_stage=args.from_stage)
    if args.cmd == "eval":
        from .eval import report
        return report.main()
    if args.cmd == "serve":
        import uvicorn
        uvicorn.run("logless.api.app:app", host=args.host, port=args.port, log_level="info", access_log=False)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
