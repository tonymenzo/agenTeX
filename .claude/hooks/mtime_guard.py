#!/usr/bin/env python3
"""Block Edit/Write/MultiEdit when the target file's mtime is newer than the last
mtime Claude observed via Read/Edit/Write. Forces a fresh Read before acting on
files the user (or another process) has touched mid-session.

Reads the hook payload from stdin (JSON), writes a decision to stdout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

STATE_DIR = Path(__file__).resolve().parent.parent / "state"
STATE_FILE = STATE_DIR / "mtime-tracking.json"
TOLERANCE = 0.01


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    event = payload.get("hook_event_name") or payload.get("event")
    tool = payload.get("tool_name") or payload.get("tool")
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("path")
    if not file_path:
        return 0

    p = Path(file_path)
    state = load_state()
    key = str(p.resolve()) if p.exists() else str(p)

    if event == "PreToolUse" and tool in ("Edit", "Write", "MultiEdit"):
        if p.exists():
            current = p.stat().st_mtime
            recorded = state.get(key)
            if recorded is not None and current > recorded + TOLERANCE:
                msg = (
                    f"{p.name} has been modified since you last read it "
                    f"(mtime {current:.2f} > {recorded:.2f}). "
                    "Use the Read tool again to load the current contents before editing — "
                    "writing now would overwrite changes the user (or another process) just made."
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
        return 0

    if event == "PostToolUse" and tool in ("Read", "Edit", "Write", "MultiEdit"):
        if p.exists():
            state[str(p.resolve())] = p.stat().st_mtime
            save_state(state)
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
