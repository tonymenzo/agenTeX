"""Canonical lists of file-extension allowlists used across agenTeX.

Lives in its own tiny module so the .claude/hooks/agentex_steer.py hook
can share the same allowlist without paying for server.py's startup
(FastAPI app construction, orchestral imports, env loading, watcher setup).
"""
from __future__ import annotations

# Plaintext-class file types the editor can open and the file watcher
# will surface in the tree. Suffix check is case-insensitive at call sites.
TEXT_SUFFIXES: tuple[str, ...] = (
    # LaTeX & docs
    ".tex", ".bib", ".cls", ".sty", ".bbx", ".cbx",
    ".md", ".rst", ".txt", ".org",
    # Python / R / Julia / Matlab
    ".py", ".pyi", ".pyx", ".r", ".jl", ".m",
    # Shell
    ".sh", ".bash", ".zsh", ".fish",
    # C / C++ / Rust / Go
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp",
    ".rs", ".go",
    # JS / TS / web
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".html", ".htm", ".css", ".scss", ".sass", ".less",
    ".vue", ".svelte",
    # JVM / Apple
    ".java", ".kt", ".scala", ".swift",
    # Other languages
    ".rb", ".pl", ".lua", ".sql", ".dart", ".elm", ".ex", ".exs", ".clj",
    # Config / data
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".csv", ".tsv", ".log",
    # Build / shell-ish
    ".dockerfile", ".gitignore", ".dockerignore",
)

# Subset that the right-hand preview pane knows how to render. Other text
# files open in the editor but the preview shows source (or nothing).
RENDERABLE_SUFFIXES: tuple[str, ...] = (".tex", ".md")
