# aTeXi — agent guide

A live LaTeX rendering surface. The user has a browser open at `localhost:8000`
showing `docs/current.tex` in CodeMirror on the left and the tectonic-rendered
PDF on the right. Edits flow over a WebSocket; the user is *watching*.

## Editing rules (load-bearing)

**Files under `docs/`** are managed by the live-preview pipeline. Always edit
them through the MCP tools, never with native Edit/Write:

- `mcp__atexi__edit_doc` — find/replace. Default for surgical changes. Set
  `stream=true` if you want the typing animation.
- `mcp__atexi__stream_edit` — append or insert at a line. Default tool for
  new sections, paragraphs, equations.

The native `Edit`/`Write` tools write to disk but **don't show up live** in
the browser editor. The user only sees them after a hard refresh, which
defeats the whole point. A PreToolUse hook in `.claude/hooks/atexi_steer.py`
blocks native Edit/Write on `docs/*.tex` to enforce this.

**Files outside `docs/`** (`server.py`, `static/`, `tools/`, `.claude/`,
`README.md`, etc.) are normal — use Edit/Write as you would anywhere.

## Session start

Before any edit on `docs/`, call `mcp__atexi__ensure_server_running`. It's a
no-op if the server's already up, and it spawns one detached if not.

## File-overwrite guard

`.claude/hooks/mtime_guard.py` blocks Edit/Write on any file whose mtime is
newer than your last Read. If you hit this, re-Read before writing — the user
(or another process) changed it since you looked.

## Architecture quick reference

- `server.py` — FastAPI + watchdog (PollingObserver) + tectonic. Render runs
  in a daemon task that serializes builds (no cancellation mid-tectonic).
- `static/` — single-page CodeMirror 5 frontend with PDF iframe.
- `templates/` — drop a `.tex` template in here; it appears in the picker.
- `tools/atexi.py` — orchestral-defined tools (the MCP surface).
- `tools/mcp_server.py` — MCP stdio entry point.
