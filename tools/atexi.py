"""Agent-callable tools for the live aTeXi document.

These tools are exposed to Claude Code via tools/mcp_server.py. They all
target the active document (docs/current.tex) and broadcast their changes
directly over the WebSocket the user's browser is connected to.

PREFER THESE TOOLS over the native Edit/Write tools when modifying any file
under aTeXi/docs/. The native tools write to disk but do NOT show up live in
the browser editor; these tools do. The user is watching --- silent disk
writes are wrong.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import requests
from orchestral import define_tool

ATEXI_ROOT = Path(__file__).resolve().parent.parent
ATEXI_BASE = os.environ.get("ATEXI_BASE", "http://127.0.0.1:8000")
SERVER_PYTHON = os.environ.get("ATEXI_PYTHON", sys.executable)


def _server_up(timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"{ATEXI_BASE}/api/doc", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


@define_tool
def ensure_server_running(wait_seconds: int = 6) -> dict[str, Any]:
    """Make sure the aTeXi web server is reachable on its expected port.

    Call this at the start of any aTeXi session, before invoking edit_doc or
    stream_edit. If the server is already up, returns immediately. If it's
    down, spawns `python server.py` as a detached background process and
    waits up to `wait_seconds` seconds for the port to become reachable.

    The spawned process survives the MCP server's lifetime --- if Claude
    Code exits, the user's browser session keeps working.
    """
    if _server_up():
        return {"running": True, "started": False, "base": ATEXI_BASE}
    proc = subprocess.Popen(
        [SERVER_PYTHON, "server.py"],
        cwd=str(ATEXI_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if _server_up():
            return {"running": True, "started": True, "pid": proc.pid, "base": ATEXI_BASE}
        time.sleep(0.3)
    return {
        "running": False,
        "started": False,
        "pid": proc.pid,
        "error": f"server did not become reachable within {wait_seconds}s",
    }


@define_tool
def read_doc() -> dict[str, Any]:
    """Return the current state of the active aTeXi document.

    Use this to load fresh content when you need to know what's in the doc
    --- e.g., before constructing a `find` for edit_doc, or after a previous
    tool response had `user_edited_since=True`. This is the canonical
    agent-side read; prefer it over the native Read tool on docs/*.tex.

    Reading also resets the `user_edited_since` flag, so the next tool call
    won't redundantly report the user's earlier edits.

    Returns:
        {"path": str, "content": str, "hash": str, "user_edited_since": bool}
        `user_edited_since` is True if the user typed in the browser since
        your last agent tool call.
    """
    r = requests.get(f"{ATEXI_BASE}/api/doc/agent", timeout=10)
    r.raise_for_status()
    return r.json()


@define_tool
def edit_doc(find: str, replace: str, stream: bool = False, delay_ms: int = 15) -> dict[str, Any]:
    """Replace a unique occurrence of `find` with `replace` in the live aTeXi doc.

    USE THIS FOR ANY EDIT to files under aTeXi/docs/. The native Edit and
    Write tools write to disk but do NOT show up live in the user's browser
    editor; this tool does. The user is watching the browser; silent disk
    writes are wrong.

    The response includes `user_edited_since`: True if the user typed in
    the browser between your previous agent tool call and this one. When
    True, your local mental model of the doc is stale --- call read_doc
    before your next edit. When False, you can keep editing without
    re-reading.

    Args:
        find: Exact text to locate in the document. MUST be unique --- include
            enough surrounding context (or extra neighboring lines) if a short
            phrase appears more than once.
        replace: Replacement text. Empty string deletes the matched region.
        stream: If True, the replacement is animated character-by-character
            (the deleted region disappears first, then chars type in). Slower
            and more dramatic --- use sparingly. Default False: instant
            replacement, still visible live in the editor.
        delay_ms: Per-character delay when streaming. Ignored when stream=False.

    Returns:
        On success: {"ok": True, "from_index": int, "to_index": int,
                     "chars": int, "user_edited_since": bool}
        On failure: {"ok": False, "status": int, "error": str}
            status 404 -> `find` not in document
            status 409 -> `find` appears more than once (add more context)
    """
    payload = {"find": find, "replace": replace, "stream": stream, "delay_ms": delay_ms}
    r = requests.post(f"{ATEXI_BASE}/api/edit", json=payload, timeout=600)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool
def stream_edit(text: str, after_line: int = -1, delay_ms: int = 15) -> dict[str, Any]:
    """Stream-insert text into the live aTeXi document character by character.

    Use this for INSERTIONS (new sections, paragraphs, equations). The user
    sees each character appear in their browser editor in real time, as if
    being typed. Tectonic re-renders once when the stream finishes.

    Prefer this tool over native Edit/Write for any insertion into
    aTeXi/docs/ --- native tools won't show up live for the user.

    The response includes `user_edited_since`: True if the user typed in
    the browser between your previous agent tool call and this one. When
    True, your local mental model of the doc is stale --- call read_doc
    before your next edit.

    Args:
        text: Content to insert. Multi-line is fine; newlines stream too.
        after_line: 0-indexed line to insert after. -1 (default) appends at
            the very end of the document.
        delay_ms: Delay between characters in milliseconds. 15 ~= 70 chars/sec.
            Use 5-10 for fast typing, 25-40 for deliberate. Set to 0 for instant
            (still visible, but no typing animation).

    Returns:
        {"ok": True, "chars": int, "insert_index": int,
         "user_edited_since": bool}
    """
    payload: dict[str, Any] = {"text": text, "delay_ms": delay_ms}
    if after_line >= 0:
        payload["after_line"] = after_line
    r = requests.post(f"{ATEXI_BASE}/api/stream", json=payload, timeout=600)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()
