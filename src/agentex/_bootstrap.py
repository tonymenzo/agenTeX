"""Per-agent project bootstrap.

Each bootstrap_<agent> function writes AGENTS.md (from the bundled
AGENT_GUIDE.md template) and the agent-specific MCP config into the target
project directory. Idempotent: re-running over an existing setup is a no-op
unless `force=True`, in which case AGENTS.md is overwritten.

Callers: cli.py for `agentex --claude` / `agentex init claude` / etc.
"""
from __future__ import annotations

import json
import sys
from importlib import resources
from pathlib import Path
from typing import Any


def _agentex_mcp_command() -> str:
    """Best-effort path to the `agentex-mcp` console script for the current
    Python env. Prefer the bin/ next to sys.executable (handles venv and
    conda envs without leaking system PATH). Fall back to the bare name and
    let PATH resolve it at MCP-launch time."""
    cand = Path(sys.executable).parent / "agentex-mcp"
    return str(cand) if cand.exists() else "agentex-mcp"


def _copy_agents_md(project_dir: Path, *, force: bool) -> tuple[Path, str]:
    """Write `project_dir/AGENTS.md` from the bundled template.

    Returns (path, status) where status is 'created', 'overwritten', or
    'kept' (existed and `force` was False).
    """
    dest = project_dir / "AGENTS.md"
    existed = dest.exists()
    if existed and not force:
        return dest, "kept"
    content = (
        resources.files("agentex.templates")
        .joinpath("AGENT_GUIDE.md")
        .read_text(encoding="utf-8")
    )
    dest.write_text(content, encoding="utf-8")
    return dest, ("overwritten" if existed else "created")


def _merge_mcp_json(path: Path, server_name: str, command: str) -> str:
    """Merge an `agenTeX` entry into an MCP-style JSON config.

    If the file doesn't exist, create it with a minimal `{mcpServers: {...}}`
    shape. If it exists and is valid JSON, preserve other keys and other
    server entries; replace ours. Returns 'created' / 'updated' / 'unchanged'.
    """
    entry: dict[str, Any] = {"command": command}
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"mcpServers": {server_name: entry}}, indent=2) + "\n",
            encoding="utf-8",
        )
        return "created"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON; refusing to clobber: {e}")
    if not isinstance(data, dict):
        raise ValueError(f"{path} root is not a JSON object")
    servers = data.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError(f"{path} has non-dict mcpServers")
    if servers.get(server_name) == entry:
        return "unchanged"
    servers[server_name] = entry
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return "updated"


def _write_claude_import_shim(project_dir: Path, *, force: bool) -> tuple[Path, str]:
    """Write a CLAUDE.md that imports AGENTS.md via `@AGENTS.md`.

    Claude Code auto-loads CLAUDE.md (and walks up directories for it) but
    does not read AGENTS.md directly. The `@AGENTS.md` import expands at
    launch, so a one-line shim makes Claude pick up the same guide other
    agents read natively, without duplicating the content."""
    dest = project_dir / "CLAUDE.md"
    existed = dest.exists()
    if existed and not force:
        return dest, "kept"
    dest.write_text("@AGENTS.md\n", encoding="utf-8")
    return dest, ("overwritten" if existed else "created")


def bootstrap_claude(project_dir: Path, *, force: bool = False) -> list[str]:
    project_dir.mkdir(parents=True, exist_ok=True)
    agents_path, agents_status = _copy_agents_md(project_dir, force=force)
    claude_path, claude_status = _write_claude_import_shim(project_dir, force=force)
    mcp_path = project_dir / ".mcp.json"
    mcp_status = _merge_mcp_json(mcp_path, "agenTeX", _agentex_mcp_command())
    return [
        f"  {agents_status:>11}  {agents_path}",
        f"  {claude_status:>11}  {claude_path}",
        f"  {mcp_status:>11}  {mcp_path}",
    ]


def bootstrap_cursor(project_dir: Path, *, force: bool = False) -> list[str]:
    project_dir.mkdir(parents=True, exist_ok=True)
    agents_path, agents_status = _copy_agents_md(project_dir, force=force)
    mcp_path = project_dir / ".cursor" / "mcp.json"
    mcp_status = _merge_mcp_json(mcp_path, "agenTeX", _agentex_mcp_command())
    return [
        f"  {agents_status:>11}  {agents_path}",
        f"  {mcp_status:>11}  {mcp_path}",
    ]


def bootstrap_codex(project_dir: Path, *, force: bool = False) -> list[str]:
    """Codex CLI's MCP servers live in `~/.codex/config.toml`, which is a
    global file we don't want to mutate without explicit user action. Write
    AGENTS.md and print the TOML snippet for the user to paste."""
    project_dir.mkdir(parents=True, exist_ok=True)
    agents_path, agents_status = _copy_agents_md(project_dir, force=force)
    cmd = _agentex_mcp_command()
    return [
        f"  {agents_status:>11}  {agents_path}",
        "",
        "  Add this to ~/.codex/config.toml to expose agenTeX to Codex:",
        "",
        "    [mcp_servers.agenTeX]",
        f'    command = "{cmd}"',
    ]


BOOTSTRAPPERS = {
    "claude": bootstrap_claude,
    "cursor": bootstrap_cursor,
    "codex": bootstrap_codex,
}
