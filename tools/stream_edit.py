"""Agent-callable tools for the live aTeXi document.

Defined with orchestral-ai's `@define_tool` so they're ready to expose to a
Claude / Anthropic agent via an MCP layer. The server's `/api/stream`
endpoint does the actual per-character broadcast.
"""
from __future__ import annotations

import os
from typing import Any

import requests
from orchestral import define_tool

ATEXI_BASE = os.environ.get("ATEXI_BASE", "http://127.0.0.1:8000")


@define_tool
def stream_edit(text: str, after_line: int = -1, delay_ms: int = 15) -> dict[str, Any]:
    """Stream text into the active aTeXi document character by character.

    The user sees each character appear in their browser editor in real time,
    as if being typed live. Tectonic re-renders once when the stream finishes.

    Args:
        text: Content to insert. Multi-line strings work (newlines stream too).
        after_line: 0-indexed line to insert after. -1 (default) appends at the
            very end of the document.
        delay_ms: Delay between characters in milliseconds. 15 ~= 70 chars/sec.
            Use 5-10 for fast, 25-40 for deliberate.

    Returns:
        {"ok": bool, "chars": int, "insert_index": int}
    """
    payload: dict[str, Any] = {"text": text, "delay_ms": delay_ms}
    if after_line >= 0:
        payload["after_line"] = after_line
    r = requests.post(f"{ATEXI_BASE}/api/stream", json=payload, timeout=600)
    r.raise_for_status()
    return r.json()
