"""agentex CLI entry point.

This is the target of the `agentex` console script declared in pyproject.toml.
It runs server.py with the same argv it was invoked with — server.py already
parses its own argv to dispatch `set` / `unset` / `<project-path>` / serve,
so we keep all that logic in one place rather than reimplementing it here.
"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path


def main() -> None:
    server = Path(__file__).resolve().parent / "server.py"
    if not server.is_file():
        print(f"agentex: server.py not found at {server}", file=sys.stderr)
        sys.exit(1)
    runpy.run_path(str(server), run_name="__main__")


if __name__ == "__main__":
    main()
