from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path


COLLECTOR = Path(__file__).with_name("collect_git_data.py")


def collect(scope: str) -> int:
    return subprocess.run(
        [sys.executable, str(COLLECTOR), "--scope", scope],
        check=False,
    ).returncode


def main() -> int:
    parser = argparse.ArgumentParser(
        description="API-only local compatibility monitor for the dashboard."
    )
    parser.add_argument("--once", action="store_true")
    parser.add_argument("scope", nargs="?", default="aps-watch")
    parser.add_argument("--reason", default="")
    parser.add_argument("--poll-seconds", type=int, default=300)
    args = parser.parse_args()

    if args.once:
        return collect(args.scope)

    while True:
        collect("aps-watch")
        time.sleep(max(args.poll_seconds, 60))


if __name__ == "__main__":
    raise SystemExit(main())
