# agen$\TeX$

A next-to-minimal live editing surface for agent-assisted writing.

I wanted a LaTeX/Markdown editor with fluid LLM integration. Existing modalities have what I'll call discontinuities, i.e., UI gaps that break flow. For example, within a web or desktop application (Claude, ChatGPT, and friends) you upload, you ask, you download, and you diff manually if you want any versioning.

CLI and API agents have no live canvas and suffer from merge races. Iterating in an IDE comes closest in my experience, but versioning and merge conflicts have to be handled by hand.

agenTeX is an attempt at addressing these shortcomings. A master editing timeline allows for clear versioning and facilitates quick rewinds. Custom tools interface agents with the served documents and open external state tools usage for literature search and citation (arXiV, Google Scholar, iNSPIRE, PDG databases, etc), agent-based web surfing, etc. A "comments" panel supports standard annotations and doubles as an agentic message board.

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

Open <http://localhost:8000>. State (`.agentex/`) and build outputs (`.build/`) live inside the project directory, so multiple projects coexist without colliding. `agentex` refuses to run on `~`, `/`, or top-level system dirs so it can't accidentally index your whole machine.

## Connect a coding agent

agenTeX talks to coding agents (Claude Code, Cursor, Codex, …) over MCP. The
launcher can wire up the project for whichever agent you use:

```bash
agentex --claude                 # bootstrap Claude wiring, then serve
agentex --cursor /path/to/proj   # bootstrap Cursor wiring, then serve
agentex --codex                  # writes AGENTS.md, prints Codex config snippet
```

Each flag writes an `AGENTS.md` (the agent's system prompt — every modern
coding agent reads this) and the agent's MCP config (`.mcp.json` for Claude
Code, `.cursor/mcp.json` for Cursor) pointing at `agentex-mcp`. The bootstrap
is idempotent — re-running over an existing setup leaves things in place,
and existing MCP entries for other servers are preserved.

To wire up without launching the server (e.g. as a one-shot project setup):

```bash
agentex init claude              # bootstrap cwd
agentex init cursor /path/proj   # bootstrap a different directory
agentex init codex --force       # overwrite an existing AGENTS.md
```

The agent guide itself is bundled with agentex (`src/agentex/templates/AGENT_GUIDE.md`)
and shipped to MCP clients both as the `instructions` field on the MCP
`initialize` response and as the AGENTS.md file the bootstrap copies into
your project. Edit the project's `AGENTS.md` to layer in project-specific
guidance — the bundled version covers agenTeX's own conventions only.

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

Rendering uses [tectonic](https://tectonic-typesetting.github.io/) — a single-binary LaTeX engine that auto-fetches packages on first use.

The agent runtime is [orchestral](https://github.com/orchestralAI/orchestral-core). Tool definitions in `src/agentex/tools/` produce both the MCP schemas surfaced to external coding agents (Claude Code, Cursor, …) and the in-process tool wrappers driving the comment-panel agent loop in `server.py` — one source, two consumers. Orchestral's MCP server wrapper is also what ships the `AGENT_GUIDE.md` content as the server-level `instructions` field on initialize.
