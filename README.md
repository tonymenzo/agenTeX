# agenTeX

Live LaTeX rendering interface for working alongside Claude Code. Edit in the browser or from your terminal, see the PDF update in real time, swap in templates as you go.

![agenTeX demo](docs/demo.gif)

## Install

### Homebrew

```bash
brew tap tonymenzo/agentex
brew install agentex
```

This pulls in `tectonic` and a self-contained Python virtualenv. The `agentex` command lands on your PATH.

### From source

```bash
brew install tectonic
git clone https://github.com/tonymenzo/agenTeX
cd agenTeX
pip install -e .
```

## Run

```bash
agentex                         # serve ./docs/ from the current directory
agentex /path/to/project        # serve that directory instead
```

Open <http://localhost:8000>. State (`.agentex/`) and build outputs (`.build/`) live inside the project directory, so multiple projects coexist without colliding.

## Configuration

Settings come from environment variables — API keys, default LLM provider/model, spend caps, bind host/port. `.env.example` lists every supported variable.

Values are read from three places, highest precedence first:

1. **Shell env** — `export ANTHROPIC_API_KEY=...`
2. **`<project>/.env`** — per-project overrides
3. **`~/.config/agentex/env`** — global user defaults (survives `brew upgrade`)

Read and write the user-level file with:

```bash
agentex set                          # list current values (secrets redacted)
agentex set ANTHROPIC_API_KEY=sk-... # write a value
agentex set AGENTEX_API_PROVIDER anthropic
agentex unset ANTHROPIC_API_KEY
```

## Layout

- `docs/current.tex` — the working document. Edits from the browser, your editor, or Claude all flow here.
- `templates/` — drop `.tex` files here; they appear in the template picker.
- `server.py` — FastAPI backend: file watcher, WebSocket sync, tectonic render.
- `static/` — single-page frontend (CodeMirror 5 + native PDF preview).
- `tools/` — MCP server exposing the live document to Claude Code.
- `.claude/` — Claude Code config, including a hook that prevents stale-write conflicts.

## Engine

Rendering uses [tectonic](https://tectonic-typesetting.github.io/) — a single-binary LaTeX engine that auto-fetches packages on first use.

## Edit-conflict guard

A `PreToolUse` hook in `.claude/settings.json` blocks Claude from editing a file whose mtime is newer than its last read. If you edit while Claude is working, Claude will be forced to re-read before continuing.
