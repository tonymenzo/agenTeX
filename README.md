# agen$\TeX$

A next-to-minimal live editing surface for agent-assisted writing.

I wanted a LaTeX/Markdown editor with fluid LLM integration. Existing modalities have UI gaps or discontinuities that break writing flow. For example, within a web or desktop application (Claude, ChatGPT, and friends) you upload, you ask, you download, and you diff manually if you want any versioning. CLI and API agents have no live canvas and suffer from merge races. Iterating in an IDE comes closest to what I want, but the agent operates on a snapshot of the document, plus output arrives as a finished patch rather than streaming onto the canvas (paying no attention to any in-flight edits when it lands).

agenTeX is an attempt at addressing these shortcomings. A master editing timeline allows for clear versioning and facilitates quick rewinds. Custom tools interface agents with the served documents and open external state tool usage for literature search, citation, agent-based web surfing, etc. A "comments" panel supports standard annotations and doubles as an agentic message board.

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
agentex                         # serve the current directory as the project
agentex /path/to/project        # serve a different directory
```

Open <http://localhost:8000>. State (`.agentex/`) and build outputs (`.build/`) live inside the project directory.

## Shortcuts

| Keys | Action |
|---|---|
| `⌘S` | Render the preview (typing already auto-saves) |
| `⌘K` | Inline prompt at the cursor: `⏎` to post a comment, or `⇧⏎` to Ask Agent |
| `⇧⌘K` | Citation modal (INSPIRE-HEP); prefills from a highlighted key or selection |
| `⌘+` `⌘-` `⌘0` | Zoom in / out / reset, routed to whichever pane has focus |
| `⌘`-click in editor | Forward-sync to the PDF (jump to the corresponding location) |
| Double-click on PDF | Inverse-sync to the editor (jump to the corresponding line) |
| `Ctrl`-scroll on PDF | Zoom anchored at the cursor |
| `Esc` | Dismiss the current modal or popup |

On non-Mac platforms `Ctrl` substitutes for `⌘`.

## Connect a coding agent

agenTeX talks to coding agents (Claude Code, Cursor, Codex, …) over MCP. The
launcher can wire up the project for whichever agent you use:

```bash
agentex --claude                 # bootstrap Claude wiring, then serve
agentex --cursor /path/to/proj   # bootstrap Cursor wiring, then serve
agentex --codex                  # writes AGENTS.md, prints Codex config snippet
```

Each flag writes an `AGENTS.md` (the agent's system prompt) and the agent's MCP config (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor) pointing at `agentex-mcp`.

To wire up without launching the server (e.g. as a one-shot project setup):

```bash
agentex init claude              # bootstrap cwd
agentex init cursor /path/proj   # bootstrap a different directory
agentex init codex --force       # overwrite an existing AGENTS.md
```

The agent guide itself is bundled with agentex (`src/agentex/templates/AGENT_GUIDE.md`) and shipped to MCP clients both as the `instructions` field on the MCP `initialize` response and as the AGENTS.md file the bootstrap copies into your project. Edit the project's `AGENTS.md` to layer in project-specific
guidance, the bundled version covers agenTeX's own conventions only.

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

## Engine

The agent tools and API interface are powered by [Orchestral](https://github.com/orchestralAI/orchestral-ai). Tool definitions in `src/agentex/tools/` get surfaced both as MCP schemas to external coding agents (Claude Code, Cursor, Codex, …) and as in-process wrappers driving the comment-panel agent loop inside agenTeX. 
Rendering uses [tectonic](https://tectonic-typesetting.github.io/), a single-binary LaTeX engine.