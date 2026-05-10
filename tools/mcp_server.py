"""MCP server entry point for aTeXi.

Exposes the orchestral-defined tools in tools/atexi.py to Claude Code via
stdio MCP. Configured in .mcp.json at the project root.
"""
from __future__ import annotations

from orchestral.mcp import MCPServer

from tools.atexi import edit_doc, ensure_server_running, stream_edit


def main() -> None:
    MCPServer(
        tools=[ensure_server_running, edit_doc, stream_edit],
        name="atexi",
        version="0.1.0",
        use_display_names=False,
    ).run()


if __name__ == "__main__":
    main()
