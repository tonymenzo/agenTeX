"""In-process orchestral tools for the direct-API agent loop.

Mirrors the MCP tool surface from tools/agentex.py but invokes the
server's async HTTP handlers directly (no localhost roundtrip). The
handlers themselves are the implementations — same broadcasts, same
snapshots, same render triggers — so behavior parity is automatic.

Each tool runs from the Agent's worker thread; we schedule the handler
coroutine on the main event loop via run_coroutine_threadsafe and block
on its result. HTTPException becomes an {ok: false, status, error}
return so the agent can recover (e.g., retry with more context).
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException
from orchestral import define_tool

from agentex.tools.agentex import StatelessRuntimeTool


def _server():
    """Lazy import to avoid the circular import with server.py."""
    from agentex import server  # noqa: WPS433
    return server


def _call_async(coro, timeout: float = 600.0) -> Any:
    """Invoke an async handler from a sync (tool) context, marshalling
    HTTPException into a structured error dict the agent can react to."""
    s = _server()
    loop = s.state.loop
    if loop is None:
        # Server hasn't finished starting up — shouldn't happen during an
        # active request, but be defensive.
        return {"ok": False, "error": "server loop not running"}
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return fut.result(timeout=timeout)
    except HTTPException as e:
        return {"ok": False, "status": e.status_code, "error": str(e.detail)}
    except asyncio.TimeoutError:
        fut.cancel()
        return {"ok": False, "error": f"timeout after {timeout}s"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------- doc browsing ----------

@define_tool(base=StatelessRuntimeTool)
def list_docs() -> dict[str, Any]:
    """List every doc in the agenTeX project.

    Returns the relative paths of every .tex/.bib/.md/.txt file under
    docs/, plus which is currently active (in the editor) and which is
    the render target (compiled by tectonic on Cmd+S).

    Returns: {names: [str], dirs: [str], active: str, render_target: str}
    """
    return _call_async(_server().get_docs())


@define_tool(base=StatelessRuntimeTool)
def read_doc(name: str = "") -> dict[str, Any]:
    """Return the full content of a doc.

    Args:
        name: forward-slash path under docs/ (e.g. "best_docs/bib.tex").
            Empty means the currently active doc.

    Returns: {ok: bool, name: str, content: str, lines: int, hash: str}
    """
    s = _server()
    if not name:
        p = s.state.active_doc
        name = s.rel_name(p)
    else:
        p = s.DOCS / name
    if not p.exists() or not p.is_file():
        return {"ok": False, "error": f"no such doc: {name}"}
    data = p.read_bytes()
    text = data.decode("utf-8", errors="replace")
    return {
        "ok": True,
        "name": name,
        "content": text,
        "lines": text.count("\n") + (0 if text.endswith("\n") else 1),
        "hash": s.sha(data),
    }


@define_tool(base=StatelessRuntimeTool)
def set_active_doc(name: str) -> dict[str, Any]:
    """Switch which doc is shown in the editor (and, for .tex/.md, the
    render target). Use this to focus a different file before editing.
    """
    return _call_async(_server().post_set_active({"name": name}))


@define_tool(base=StatelessRuntimeTool)
def new_doc(name: str, template: str = "", activate: bool = True) -> dict[str, Any]:
    """Create a new doc under docs/.

    Args:
        name: forward-slash relative path under docs/, including extension
            (.tex/.bib/.md/.txt). Subdirs auto-create.
        template: optional template filename from templates/. Empty = minimal scaffold.
        activate: when True, switch to the new doc immediately.
    """
    payload: dict[str, Any] = {"name": name, "activate": activate}
    if template:
        payload["template"] = template
    return _call_async(_server().post_new_doc(payload))


@define_tool(base=StatelessRuntimeTool)
def move_doc(src: str, dest: str) -> dict[str, Any]:
    """Move or rename a doc or folder under docs/. Migrates active/render-target
    pointers and the .build/ output so re-renders don't orphan stale PDFs."""
    return _call_async(_server().post_move({"src": src, "dest": dest}))


# ---------- editing ----------

@define_tool(base=StatelessRuntimeTool)
def edit_doc(
    find: str,
    replace: str,
    stream: bool = False,
    delay_ms: int = 15,
) -> dict[str, Any]:
    """Replace a unique occurrence of `find` with `replace` in the active doc.

    `find` MUST appear exactly once — include surrounding context if a short
    phrase repeats. Returns 404 (find not present) or 409 (not unique).
    `stream=True` types the replacement character-by-character.
    """
    payload = {
        "find": find,
        "replace": replace,
        "stream": stream,
        "delay_ms": delay_ms,
    }
    return _call_async(_server().edit_doc(payload))


@define_tool(base=StatelessRuntimeTool)
def stream_edit(text: str, after_line: int = -1, delay_ms: int = 15) -> dict[str, Any]:
    """Stream-insert text into the active doc, character by character.

    Args:
        text: content to insert; newlines are streamed too.
        after_line: 0-indexed line to insert after. -1 (default) = end.
        delay_ms: per-char delay (15 ≈ 70cps).
    """
    payload: dict[str, Any] = {"text": text, "delay_ms": delay_ms}
    if after_line >= 0:
        payload["after_line"] = after_line
    return _call_async(_server().stream(payload))


# ---------- comments ----------

@define_tool(base=StatelessRuntimeTool)
def list_comments(
    doc: str = "",
    author: str = "",
    include_resolved: bool = False,
    pending_only: bool = False,
) -> dict[str, Any]:
    """List comments across the project. `author="user", pending_only=True`
    surfaces user prompts awaiting an agent reply."""
    return _call_async(
        _server().get_comments(
            doc=doc,
            include_resolved=include_resolved,
            author=author,
            pending_only=pending_only,
        )
    )


@define_tool(base=StatelessRuntimeTool)
def add_comment(
    message: str,
    excerpt: str = "",
    line: int = -1,
    doc: str = "",
    parent_id: str = "",
) -> dict[str, Any]:
    """Post a comment. With `parent_id`, replies to an existing thread
    (anchor inherited). Without it, anchors via excerpt > line > doc-level.
    """
    payload: dict[str, Any] = {"message": message}
    if excerpt:
        payload["excerpt"] = excerpt
    if line >= 1:
        payload["line"] = line
    if doc:
        payload["doc"] = doc
    if parent_id:
        payload["parent_id"] = parent_id
    return _call_async(_server().post_comment(payload))


@define_tool(base=StatelessRuntimeTool)
def resolve_comment(comment_id: str, resolved: bool = True) -> dict[str, Any]:
    """Mark a comment resolved (or re-open with resolved=False)."""
    return _call_async(
        _server().post_resolve_comment(comment_id, {"resolved": resolved})
    )


@define_tool(base=StatelessRuntimeTool)
def delete_comment(comment_id: str) -> dict[str, Any]:
    """Permanently remove a comment. Prefer resolve_comment unless cleaning
    up a duplicate / mistake."""
    return _call_async(_server().delete_comment(comment_id))


# Full surface registered with the Agent. Mirrors the MCP tools in
# tools/agentex.py modulo ensure_server_running (irrelevant in-process).
AGENT_TOOLS = [
    list_docs,
    read_doc,
    set_active_doc,
    new_doc,
    move_doc,
    edit_doc,
    stream_edit,
    list_comments,
    add_comment,
    resolve_comment,
    delete_comment,
]
