"""MCP server entry point for agenTeX.

Exposes the orchestral-defined tools in tools/agentex.py to Claude Code via
stdio MCP. Configured in .mcp.json at the project root.
"""
from __future__ import annotations

from orchestral.mcp import MCPServer

from agentex.tools.agentex import (
    add_comment,
    delete_comment,
    edit_doc,
    ensure_server_running,
    get_comment,
    list_comments,
    list_docs,
    new_doc,
    read_doc,
    resolve_comment,
    set_active_doc,
    stream_edit,
)


def main() -> None:
    MCPServer(
        tools=[
            ensure_server_running,
            list_docs,
            set_active_doc,
            new_doc,
            read_doc,
            edit_doc,
            stream_edit,
            add_comment,
            list_comments,
            get_comment,
            resolve_comment,
            delete_comment,
        ],
        name="agenTeX",
        version="0.1.0",
        use_display_names=True,
    ).run()


if __name__ == "__main__":
    main()
