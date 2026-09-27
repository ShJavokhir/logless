"""Operator-only entry point. Never exposes source records through the API."""
from __future__ import annotations
import argparse
import os
import json
from pathlib import Path
from ..config import REPO_ROOT
from .seed import generate
from .pipeline import rebuild


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    seed = sub.add_parser("seed")
    seed.add_argument("--count", type=int, default=600)
    seed.add_argument("--directory", type=Path, default=REPO_ROOT / "backend/fixtures/synthetic")
    build = sub.add_parser("rebuild")
    build.add_argument("--source", type=Path, default=REPO_ROOT / "backend/fixtures/synthetic/conversations.jsonl")
    build.add_argument("--limit", type=int)
    build.add_argument("--concurrency", type=int, default=4)
    build.add_argument("--cutoff", type=float, default=.65)
    build.add_argument("--evolve", action="store_true")
    args = p.parse_args()
    os.environ.setdefault("LOGLESS_DATA_DIR", "./var-synthetic")
    result = generate(args.directory, args.count) if args.cmd == "seed" else rebuild(args.source, limit=args.limit, concurrency=args.concurrency, cutoff=args.cutoff, evolve=args.evolve)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
