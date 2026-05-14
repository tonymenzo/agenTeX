"""agentex CLI entry point.

Surface:

    agentex                          # launch server on cwd
    agentex <path>                   # launch server on <path>
    agentex --claude  [<path>]       # bootstrap Claude wiring + launch
    agentex --cursor  [<path>]       # bootstrap Cursor wiring + launch
    agentex --codex   [<path>]       # bootstrap Codex wiring + launch
    agentex init claude|cursor|codex [<path>] [--force]   # bootstrap only
    agentex set KEY=VALUE / unset KEY                     # passthrough

The agent flags do a one-shot project setup (write AGENTS.md, write/merge
the agent's MCP config), then fall through to the normal server launch.
`init` does only the bootstrap and exits. Everything else (positional
project path, `set`/`unset` config subcommands, env vars) flows through
unchanged to server.py, which owns that argv parsing.
"""
from __future__ import annotations

import argparse
import runpy
import sys
from pathlib import Path


_AGENT_FLAGS = {"--claude": "claude", "--cursor": "cursor", "--codex": "codex"}


def main() -> None:
    argv = sys.argv[1:]

    if argv and argv[0] == "init":
        sys.exit(_cmd_init(argv[1:]))

    agent: str | None = None
    rest: list[str] = []
    for a in argv:
        if a in _AGENT_FLAGS:
            if agent is not None:
                print(
                    f"agentex: cannot combine --{agent} with {a}",
                    file=sys.stderr,
                )
                sys.exit(2)
            agent = _AGENT_FLAGS[a]
        else:
            rest.append(a)

    if agent is not None:
        positional = [x for x in rest if not x.startswith("-")]
        # `agentex --claude set/unset ...` is a config passthrough; don't
        # silently write AGENTS.md / .mcp.json into cwd in that case.
        if not (positional and positional[0] in ("set", "unset")):
            project_dir = (
                Path(positional[0]).expanduser() if positional else Path.cwd()
            )
            _run_bootstrap(agent, project_dir, force=False)

    sys.argv = [sys.argv[0]] + rest
    _exec_server()


def _cmd_init(args: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="agentex init",
        description="Bootstrap a project for use with a coding agent. "
        "Writes AGENTS.md and the agent's MCP config; does not launch the server.",
    )
    parser.add_argument(
        "agent",
        choices=sorted({"claude", "cursor", "codex"}),
        help="Which agent to wire up.",
    )
    parser.add_argument(
        "project_dir",
        nargs="?",
        default=".",
        help="Project root to bootstrap (default: cwd).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing AGENTS.md.",
    )
    ns = parser.parse_args(args)
    project_dir = Path(ns.project_dir).expanduser().resolve()
    _run_bootstrap(ns.agent, project_dir, force=ns.force)
    return 0


def _run_bootstrap(agent: str, project_dir: Path, *, force: bool) -> None:
    from agentex._bootstrap import BOOTSTRAPPERS

    print(f"agentex: bootstrap {agent} in {project_dir}")
    try:
        messages = BOOTSTRAPPERS[agent](project_dir, force=force)
    except ValueError as e:
        print(f"agentex: bootstrap failed: {e}", file=sys.stderr)
        sys.exit(1)
    for line in messages:
        print(line)


def _exec_server() -> None:
    server = Path(__file__).resolve().parent / "server.py"
    if not server.is_file():
        print(f"agentex: server.py not found at {server}", file=sys.stderr)
        sys.exit(1)
    runpy.run_path(str(server), run_name="__main__")


if __name__ == "__main__":
    main()
