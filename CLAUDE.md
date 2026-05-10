# aTeXi — agent guide

A live LaTeX rendering surface. The user has a browser open at `localhost:8000`
showing `docs/current.tex` in CodeMirror on the left and the tectonic-rendered
PDF on the right. Edits flow over a WebSocket; the user is *watching*.

## Editing rules (load-bearing)

**Files under `docs/`** are managed by the live-preview pipeline. Always edit
them through the MCP tools, never with native Edit/Write:

- `mcp__atexi__list_docs` — list all `.tex` / `.bib` files in `docs/`.
  Returns `active` (what's in the editor) and `render_target` (what
  Render compiles).
- `mcp__atexi__read_doc` — fetch current content of the active doc. Use
  this instead of the native Read tool on `docs/*.tex` and `docs/*.bib`.
- `mcp__atexi__set_active_doc` — switch which doc is active. Switching to
  a `.tex` also makes it the render target; switching to a `.bib` keeps
  the previous `.tex` as the render target so the main draft still
  compiles.
- `mcp__atexi__new_doc` — create a new `.tex` or `.bib` in `docs/`,
  optionally seeded from a template in `templates/`.
- `mcp__atexi__edit_doc` — find/replace. Default for surgical changes. Set
  `stream=true` if you want the typing animation.
- `mcp__atexi__stream_edit` — append or insert at a line. Default tool for
  new sections, paragraphs, equations.

`edit_doc`, `stream_edit`, and `read_doc` always operate on the **active**
doc. If you need to edit a different doc, call `set_active_doc` first.

The native `Edit`/`Write` tools write to disk but **don't show up live** in
the browser editor. The user only sees them after a hard refresh, which
defeats the whole point. A PreToolUse hook in `.claude/hooks/atexi_steer.py`
blocks native Edit/Write on `docs/*.tex` to enforce this.

**Files outside `docs/`** (`server.py`, `static/`, `tools/`, `.claude/`,
`README.md`, etc.) are normal — use Edit/Write as you would anywhere.

## Re-reading protocol

Every agent tool call returns a `user_edited_since` flag. It's True when the
user has typed in the browser between your previous tool call and this one.

- `user_edited_since=False`: your mental model of the doc is current. Keep
  editing without re-reading.
- `user_edited_since=True`: the user has changed the doc. Call `read_doc`
  before your next edit so your `find` arguments still match.

You don't need to re-read between every edit by default; only when the flag
says so. On your first call in a session, the flag is meaningless --- start
with a `read_doc` if you need content.

## Render on Cmd+S, not on every keystroke

The user typing in the browser writes to disk but does NOT trigger a
tectonic render. The status bar flips to a yellow "⌘S to render" dot, and
the user presses Cmd/Ctrl-S to compile when they're ready. Agent edits via
`edit_doc` / `stream_edit` always render automatically --- the user only
opts in for their own typing.

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
