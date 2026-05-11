# agenTeX

Live LaTeX rendering interface for working alongside Claude Code. Edit in the browser or from your terminal, see the PDF update in real time, swap in templates as you go.

## Setup

```bash
conda activate agentex
python server.py
```

Open <http://localhost:8000>.

## Layout

- `docs/current.tex` — the working document. Edits from the browser, your editor, or Claude all flow here.
- `templates/` — drop `.tex` files here; they appear in the template picker.
- `server.py` — FastAPI backend: file watcher, WebSocket sync, tectonic render.
- `static/` — single-page frontend (CodeMirror 6 + native PDF preview).
- `.claude/` — Claude Code config, including a hook that prevents stale-write conflicts.

## Engine

Rendering uses [tectonic](https://tectonic-typesetting.github.io/) — a single-binary LaTeX engine that auto-fetches packages on first use.

## Edit-conflict guard

A `PreToolUse` hook in `.claude/settings.json` blocks Claude from editing a file whose mtime is newer than its last read. If you edit while Claude is working, Claude will be forced to re-read before continuing.
