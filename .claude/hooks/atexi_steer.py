#!/usr/bin/env python3
"""Steer agent edits on agenTeX/docs/*.{tex,bib,md} toward the MCP tools.

Blocks native Edit/Write/MultiEdit when the target is a managed doc
under docs/, with a message redirecting the agent to mcp__atexi__edit_doc
or mcp__atexi__stream_edit. Native tools write to disk but don't
broadcast, so the user's browser editor would silently fall out of sync.

To disable: remove this hook's entry from .claude/settings.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = (PROJECT_ROOT / "docs").resolve()


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    event = payload.get("hook_event_name") or payload.get("event")
    tool = payload.get("tool_name") or payload.get("tool")
    if event != "PreToolUse" or tool not in ("Edit", "Write", "MultiEdit"):
        return 0

    file_path = (payload.get("tool_input") or {}).get("file_path")
    if not file_path:
        return 0

    p = Path(file_path)
    try:
        resolved = p.resolve()
    except OSError:
        resolved = p
    try:
        resolved.relative_to(DOCS_DIR)
    except ValueError:
        return 0
    if resolved.suffix not in (".tex", ".bib", ".md"):
        return 0

    msg = (
        f"BLOCKED: {resolved.name} is part of agenTeX's live document set "
        "and the user is watching it in a browser editor. Native Edit/Write "
        "tools write to disk silently --- the user's editor will not update. "
        "Use `mcp__atexi__edit_doc` for find/replace edits, or "
        "`mcp__atexi__stream_edit` for inserts/appends. Both broadcast to "
        "the browser over the same WebSocket."
    )
    out = {
        "decision": "block",
        "reason": msg,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": msg,
        },
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
