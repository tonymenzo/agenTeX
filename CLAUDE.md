# agenTeX — agent guide

A live editing surface. The user has a browser open at `localhost:8000` showing
the project tree on the left and a preview pane on the right (tectonic PDF for
`.tex`, KaTeX/marked HTML for `.md`, source-only for everything else). Edits
flow over a WebSocket; the user is *watching*.

The project root is whatever directory `agentex` was launched in (cwd by
default, overridable via positional arg or `AGENTEX_PROJECT`). The editor
surfaces every text file under that root — `.tex`, `.bib`, `.md`, `.py`,
`.sh`, `.cc`, `.toml`, `.json`, … (canonical list in `src/agentex/_suffixes.py`).
Hidden dirs and common build dirs (`build/`, `dist/`, `node_modules/`,
`__pycache__/`, …) are pruned automatically.

## Editing rules (load-bearing)

Native `Edit`/`Write` writes to disk but **doesn't broadcast**. When the user
is viewing a file in the browser editor, native edits go silently out of sync;
the user only sees the change after a hard refresh, defeating the whole point.

Practical rule:

- **User-authored content** (anything in `docs/`: manuscripts, bibs, notes,
  scratchpads) — always via the MCP tools below.
- **agentex source / config** (`src/agentex/…`, `pyproject.toml`, `.claude/…`,
  `README.md`, etc.) — native `Edit`/`Write` is fine, even though these
  surface in the tree. The user typically isn't live-viewing them, and source
  changes need a restart / hard refresh anyway.

A PreToolUse hook (`.claude/hooks/agentex_steer.py`) hard-blocks native
Edit/Write on any text file under `docs/` to enforce the first rule. Files
outside `docs/` aren't blocked — judgment call per the practical rule.

### Doc tools

`EditDoc`, `StreamEdit`, and `ReadDoc` always operate on the **active** doc.
To edit a different doc, call `SetActiveDoc` first.

- `mcp__agenTeX__ListDocs` — list every text file in the project. Returns
  `names`, `dirs`, `assets`, plus `active` (what's in the editor) and
  `render_target` (what Render compiles).
- `mcp__agenTeX__ReadDoc` — fetch current content of the active doc. Use
  this instead of native `Read` when the user is viewing the doc.
- `mcp__agenTeX__SetActiveDoc` — switch which doc is active. Switching to a
  renderable file (`.tex`, `.md`) also makes it the render target; switching
  to anything else leaves the render target on the previous renderable so
  the main draft still compiles.
- `mcp__agenTeX__NewDoc` — create a new file under the project root, optionally
  seeded from a template in `src/agentex/templates/`.
- `mcp__agenTeX__EditDoc` — find/replace. Default for surgical changes. Set
  `stream=true` for typing animation.
- `mcp__agenTeX__StreamEdit` — append or insert at a line. Default tool for
  new sections, paragraphs, equations.

### Comment tools

The right-hand sidebar holds threaded review comments anchored to a text
excerpt, a line, or the whole doc. They survive edits — re-anchored on text
moves, marked `orphaned` (never deleted) if the anchor can't be found.

- `mcp__agenTeX__GetComment` — fetch one comment by id, plus any replies.
  This is the right tool when the user references a specific `c00NN`
  ("address c0084"). Returns `{"comment": {...}, "replies": [...]}`.
- `mcp__agenTeX__ListComments` — returns every matching comment. **Filter
  aggressively** with `doc=`, `author=`, and/or `pending_only=true`. The
  unfiltered default (`include_resolved=true`) blows past the tool-result
  size limit on any doc with real activity.
- `mcp__agenTeX__AddComment` — post a new top-level comment, or a reply
  via `parent_id`. Anchor with `excerpt=` (must be unique in the doc) or
  `line=`.
- `mcp__agenTeX__ResolveComment` — mark resolved (or re-open with
  `resolved=false`). Use after an edit addresses what the comment flagged.
- `mcp__agenTeX__DeleteComment` — permanent removal. Prefer Resolve unless
  the comment is junk.

## Re-reading protocol

Every doc tool call returns a `user_edited_since` flag. It's True when the
user has typed in the browser between your previous tool call and this one.

- `user_edited_since=False`: your mental model of the doc is current. Keep
  editing without re-reading.
- `user_edited_since=True`: the user has changed the doc. Call `ReadDoc`
  before your next edit so your `find` arguments still match.

You don't need to re-read between every edit by default; only when the flag
says so. On your first call in a session the flag is meaningless — start with
`ReadDoc` if you need content.

## Render on Cmd+S, not on every keystroke

The user typing in the browser writes to disk but does NOT trigger a tectonic
render. The status bar flips to a yellow "⌘S to render" dot, and the user
presses Cmd/Ctrl-S to compile when they're ready. Agent edits via `EditDoc` /
`StreamEdit` always render automatically — the user only opts in for their
own typing.

## Session start

Before any edit, call `mcp__agenTeX__EnsureServerRunning`. It's a no-op if the
server's already up, and it spawns one detached if not.

## File-overwrite guard

`.claude/hooks/mtime_guard.py` blocks Edit/Write on any file whose mtime is
newer than your last Read. If you hit this, re-Read before writing — the user
(or another process) changed it since you looked.

## Architecture quick reference

- `src/agentex/server.py` — FastAPI + watchdog (PollingObserver) + tectonic.
  Render runs in a daemon task that serializes builds (no cancellation
  mid-tectonic). Pure-cwd project default with a deny-list for `~`, `/`, and
  top-level system dirs.
- `src/agentex/static/` — single-page CodeMirror 5 frontend with PDF.js
  preview. PDF canvases are cached by URL so `.md ↔ .tex` toggles are a sync
  DOM swap; tab reorder is HTML5 DnD with FLIP animation.
- `src/agentex/templates/` — drop a `.tex` template in here; it appears in
  the picker.
- `src/agentex/tools/agentex.py` — orchestral-defined MCP tools (this file
  documents their use).
- `src/agentex/tools/mcp_server.py` — MCP stdio entry point, exposed as the
  `agentex-mcp` console script.
- `src/agentex/_suffixes.py` — canonical `TEXT_SUFFIXES` (editable) and
  `RENDERABLE_SUFFIXES` (compiles to a preview pane), shared with the steer
  hook.
- `src/agentex/cli.py` — the `agentex` console script.
- Project listing (`list_doc_names` / `list_doc_dirs` / `list_asset_names`)
  is a single cached `os.walk` invalidated by the file watcher; cold ~1ms,
  cached free.
