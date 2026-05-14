"""Agent-callable tools for the live agenTeX document.

These tools are exposed to Claude Code via tools/mcp_server.py. They all
target the active document (docs/current.tex) and broadcast their changes
directly over the WebSocket the user's browser is connected to.

PREFER THESE TOOLS over the native Edit/Write tools when modifying any file
under agentex/docs/. The native tools write to disk but do NOT show up live
in the browser editor; these tools do. The user is watching --- silent disk
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
from orchestral.tools.base.field_utils import is_state_field
from orchestral.tools.base.tool import BaseTool
from pydantic_core import PydanticUndefined

AGENTEX_ROOT = Path(__file__).resolve().parent.parent
AGENTEX_BASE = os.environ.get("AGENTEX_BASE", "http://127.0.0.1:8000")
SERVER_PYTHON = os.environ.get("AGENTEX_PYTHON", sys.executable)


class StatelessRuntimeTool(BaseTool):
    """Reset runtime fields to their declared defaults at the start of every
    execute() call so values from a prior MCP invocation don't bleed into a
    later one. orchestral's stock BaseTool reuses the tool instance and merges
    new kwargs on top of leftover state, so a default like `excerpt: str = ""`
    silently inherits the previous call's value when the new call omits the
    arg. Without this reset, an MCP tool that sometimes wants `excerpt` and
    sometimes wants `line` can't switch cleanly --- the absent arg picks up
    whatever was set last time.
    """

    def execute(self, stream_callback=None, **kwargs):
        for field_name, field_info in type(self).model_fields.items():
            if is_state_field(field_info):
                continue
            if field_name in kwargs:
                continue
            default = field_info.default
            if default is PydanticUndefined:
                # Required field with no default — let BaseTool's own
                # missing-fields check handle it.
                continue
            setattr(self, field_name, default)
        return super().execute(stream_callback=stream_callback, **kwargs)


def _server_up(timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"{AGENTEX_BASE}/api/doc", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


@define_tool(base=StatelessRuntimeTool)
def ensure_server_running(
    wait_seconds: int = 6,
    project_path: str = "",
) -> dict[str, Any]:
    """Make sure the agenTeX web server is reachable on its expected port.

    Call this at the start of any agenTeX session, before invoking edit_doc
    or stream_edit. If the server is already up, returns immediately (the
    running server's project path is whatever was passed when IT was
    launched — this tool does NOT restart a running server to repoint it).
    If it's down, spawns `python server.py [project_path]` as a detached
    background process and waits up to `wait_seconds` seconds for the port
    to become reachable.

    `project_path`: optional absolute path to root the editor at. When
    given, `.agentex` and `.build` live inside that path. When empty, the
    server uses AGENTEX_PROJECT from the environment, falling back to the
    in-repo `docs/`.

    The spawned process survives the MCP server's lifetime --- if Claude
    Code exits, the user's browser session keeps working.
    """
    if _server_up():
        return {"running": True, "started": False, "base": AGENTEX_BASE}
    cmd = [SERVER_PYTHON, "server.py"]
    if project_path:
        cmd.append(project_path)
    proc = subprocess.Popen(
        cmd,
        cwd=str(AGENTEX_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if _server_up():
            return {
                "running": True,
                "started": True,
                "pid": proc.pid,
                "base": AGENTEX_BASE,
                "project_path": project_path or None,
            }
        time.sleep(0.3)
    return {
        "running": False,
        "started": False,
        "pid": proc.pid,
        "project_path": project_path or None,
        "error": f"server did not become reachable within {wait_seconds}s",
    }


@define_tool(base=StatelessRuntimeTool)
def list_docs() -> dict[str, Any]:
    """List all documents in the agenTeX docs/ folder.

    Returns the names of every .tex, .bib, .md, and .txt file, plus
    which one is currently active (visible in the editor) and which is
    the render target (compiled or rendered when the user clicks
    Render). Use this to discover what's available before switching.

    File names are forward-slash relative paths under docs/ — e.g.
    "current.tex" or "chapters/intro.tex". `dirs` lists every
    subdirectory (including empty ones) so you can see the folder
    structure even before placing docs in it.

    Returns:
        {"names": [str], "dirs": [str], "active": str, "render_target": str}
    """
    r = requests.get(f"{AGENTEX_BASE}/api/docs", timeout=10)
    r.raise_for_status()
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def set_active_doc(name: str) -> dict[str, Any]:
    """Switch the active agenTeX document to `name`.

    The active doc is what the editor displays and what edit_doc /
    stream_edit operate on. If `name` is a .tex or .md file, it also
    becomes the render target (.tex compiles via tectonic to PDF; .md
    renders client-side to HTML with KaTeX math). Switching to a .bib
    or .txt leaves the render target on the previous renderable so the
    main draft still rebuilds when the user hits Render.

    Args:
        name: forward-slash relative path under docs/ (e.g. "notes.tex",
            "chapters/intro.tex", "refs.bib", "scratch.md", "notes.txt").
            Must already exist.

    Returns:
        {"ok": True, "active": str, "render_target": str}
    """
    r = requests.post(
        f"{AGENTEX_BASE}/api/docs/active",
        json={"name": name},
        timeout=10,
    )
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def new_doc(name: str, template: str = "", activate: bool = True) -> dict[str, Any]:
    """Create a new document in agentex/docs/.

    Args:
        name: forward-slash relative path under docs/, including
            extension. Each segment must contain only [A-Za-z0-9._-]
            characters; the final segment must end in .tex, .bib, .md,
            or .txt. Subdirectories (e.g. "chapters/intro.tex") are
            auto-created on write — no separate mkdir step needed.
        template: optional template filename from agentex/templates/. If
            empty, a minimal scaffold is used (\\documentclass...\\end{document}
            for .tex, a comment header for .bib, a single H1 for .md,
            an empty file for .txt).
        activate: when True (default) the new file becomes the active
            doc immediately.

    Returns:
        {"ok": True, "active": str, "render_target": str} when activate=True,
        else {"ok": True, "name": str}.
    """
    payload: dict[str, Any] = {"name": name, "activate": activate}
    if template:
        payload["template"] = template
    r = requests.post(f"{AGENTEX_BASE}/api/docs/new", json=payload, timeout=15)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def move_doc(src: str, dest: str) -> dict[str, Any]:
    """Move or rename a document or directory under agentex/docs/.

    Works for both files and folders — pass a file path to rename or move
    a single doc, or a folder path to rename/move the whole subtree. Parent
    directories of `dest` are auto-created. The associated .build/ output
    (PDF, log, or the whole BUILD subtree for a folder move) follows the
    source, so re-renders don't orphan stale output.

    Behavior on edge cases:
        - Refuses to overwrite an existing destination (409).
        - Refuses to move a folder into itself or its own descendant (400).
        - Migrates state.active_doc and state.render_target if they point
          at (or live inside) the moved entity, so the editor lands on the
          new path without a flicker.

    Args:
        src: existing path under docs/ (e.g. "chapters/intro.tex" or
            "chapters" for the folder itself).
        dest: target path. For files, must end in .tex / .bib / .md / .txt
            and follow the doc filename rules. For folders, no extension.
            Each segment must contain only [A-Za-z0-9._-] characters.

    Returns:
        On success: {"ok": True, "src": str, "dest": str, "is_dir": bool}
        On no-op (src == dest): adds {"noop": True}
        On failure: {"ok": False, "status": int, "error": str}
    """
    r = requests.post(
        f"{AGENTEX_BASE}/api/docs/move",
        json={"src": src, "dest": dest},
        timeout=15,
    )
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def read_doc() -> dict[str, Any]:
    """Return the current state of the active agenTeX document.

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
    r = requests.get(f"{AGENTEX_BASE}/api/doc/agent", timeout=10)
    r.raise_for_status()
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def edit_doc(find: str, replace: str, stream: bool = True, delay_ms: int = 15) -> dict[str, Any]:
    """Replace a unique occurrence of `find` with `replace` in the live agenTeX doc.

    USE THIS FOR ANY EDIT to files under agentex/docs/. The native Edit and
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
        stream: If True (default), the replacement is animated character-by-
            character (the deleted region disappears first, then chars type
            in). This is the right behavior for prose changes the user wants
            to witness as they happen. Set False for mechanical edits where
            the animation is noise: whitespace/indentation fixes, renames,
            code-block fence repairs, very long replacements where the
            typewriter pass would outlast the user's patience, or tight
            sequential edit loops where the cumulative animation blocks
            further work.
        delay_ms: Per-character delay when streaming. Ignored when stream=False.

    Returns:
        On success: {"ok": True, "from_index": int, "to_index": int,
                     "chars": int, "user_edited_since": bool}
        On failure: {"ok": False, "status": int, "error": str}
            status 404 -> `find` not in document
            status 409 -> `find` appears more than once (add more context)
    """
    payload = {"find": find, "replace": replace, "stream": stream, "delay_ms": delay_ms}
    r = requests.post(f"{AGENTEX_BASE}/api/edit", json=payload, timeout=600)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def add_comment(
    message: str,
    excerpt: str = "",
    line: int = -1,
    doc: str = "",
    parent_id: str = "",
) -> dict[str, Any]:
    """Attach a non-destructive comment to the active agenTeX document, or
    reply to an existing comment.

    Use this for review-style feedback that should NOT modify the prose:
    flag a citation that may be wrong, suggest a phrasing tweak, answer
    a user's question on a previous comment, etc. Comments surface as a
    yellow dot in the gutter and in the Comments sidebar.

    Anchor selection (used only when NOT a reply), in order of preference:
      - excerpt: unique substring -> range anchor (preferred for text-
        specific feedback). 404 if not found, 409 if not unique.
      - line: 1-indexed line anchor (for comments without specific text).
      - neither: doc-level comment at the top of the sidebar.

    Replies (parent_id set) inherit their anchor from the parent comment,
    so the whole thread moves together when the parent re-anchors. Replies
    do NOT add new gutter dots; they appear nested under the parent in the
    sidebar.

    Args:
        message: The comment text. Required.
        excerpt: Exact substring to anchor on. Must be unique.
        line: 1-indexed line anchor; ignored if `excerpt` is given.
        doc: Doc path relative to docs/. Defaults to the active doc.
        parent_id: If set, post this as a reply to that comment id.
            Anchor + doc are inherited from the parent.

    Returns:
        On success: {"ok": True, "comment": {...}}
        On failure: {"ok": False, "status": int, "error": str}
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
    r = requests.post(f"{AGENTEX_BASE}/api/comments", json=payload, timeout=15)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def list_comments(
    doc: str = "",
    include_resolved: bool = False,
    author: str = "",
    pending_only: bool = False,
) -> dict[str, Any]:
    """List comments on the agenTeX docs.

    Args:
        doc: Filter by doc path (relative to docs/). Empty = all docs.
        include_resolved: When True, include resolved comments too. Default
            False (only open comments).
        author: Filter by author ("user" or "agent"). Empty = both.
        pending_only: When True, return only comments that don't yet have a
            reply by a different author. Combined with author="user", this
            is the "what's waiting for me to answer" view for the agent.

    Returns:
        {"comments": [{id, doc, kind, message, parent_id, ...anchor fields,
                       resolved, orphaned, ts, author}, ...]}
        Anchor fields depend on `kind`:
          - "range": from_line, to_line, from_ch, to_ch, excerpt
          - "line":  line, line_text
          - "doc":   (none)
          - "reply": parent_id only; inherits anchor from parent thread
        `orphaned: true` means the original anchor text can no longer be
        located in the doc (it was edited away).
    """
    params: dict[str, Any] = {
        "include_resolved": "true" if include_resolved else "false",
        "pending_only": "true" if pending_only else "false",
    }
    if doc:
        params["doc"] = doc
    if author:
        params["author"] = author
    r = requests.get(f"{AGENTEX_BASE}/api/comments", params=params, timeout=10)
    r.raise_for_status()
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def get_comment(comment_id: str) -> dict[str, Any]:
    """Fetch a single comment by id, plus any replies to it.

    Use this when the user references a specific comment ("address c0084")
    instead of dumping every comment with `list_comments` and searching the
    result — `list_comments` payloads on busy docs can exceed tool-result
    size limits.

    Args:
        comment_id: The `id` field, like "c0084".

    Returns:
        On success: {"comment": {...}, "replies": [{...}, ...]}
            `comment` is the full record (id, doc, message, author, ts,
            resolved, orphaned, parent_id, kind, anchor fields).
            `replies` is the comments whose `parent_id` matches.
        On failure: {"ok": False, "status": int, "error": str}
            status 404 -> no comment with that id.
    """
    r = requests.get(f"{AGENTEX_BASE}/api/comments/{comment_id}", timeout=10)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def resolve_comment(comment_id: str, resolved: bool = True) -> dict[str, Any]:
    """Mark a comment resolved (hidden from the default sidebar view) or
    re-open it. Use this when the user's reply or your follow-up edit has
    addressed what the comment flagged.

    Args:
        comment_id: The `id` field from list_comments.
        resolved: True to resolve, False to re-open. Default True.

    Returns:
        On success: {"ok": True, "comment": {...}}
        On failure: {"ok": False, "status": int, "error": str}
    """
    r = requests.post(
        f"{AGENTEX_BASE}/api/comments/{comment_id}/resolve",
        json={"resolved": resolved},
        timeout=10,
    )
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def delete_comment(comment_id: str) -> dict[str, Any]:
    """Permanently remove a comment. Prefer resolve_comment unless you're
    cleaning up a mistaken or duplicate entry --- resolved comments can
    still be browsed by toggling 'Show resolved' in the sidebar; deleted
    ones are gone.

    Args:
        comment_id: The `id` field from list_comments.

    Returns:
        On success: {"ok": True, "removed": str}
        On failure: {"ok": False, "status": int, "error": str}
    """
    r = requests.delete(f"{AGENTEX_BASE}/api/comments/{comment_id}", timeout=10)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()


@define_tool(base=StatelessRuntimeTool)
def stream_edit(text: str, after_line: int = -1, delay_ms: int = 15) -> dict[str, Any]:
    """Stream-insert text into the live agenTeX document character by character.

    Use this for INSERTIONS (new sections, paragraphs, equations). The user
    sees each character appear in their browser editor in real time, as if
    being typed. Tectonic re-renders once when the stream finishes.

    Prefer this tool over native Edit/Write for any insertion into
    agentex/docs/ --- native tools won't show up live for the user.

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
    r = requests.post(f"{AGENTEX_BASE}/api/stream", json=payload, timeout=600)
    if not r.ok:
        return {"ok": False, "status": r.status_code, "error": r.text[:500]}
    return r.json()
