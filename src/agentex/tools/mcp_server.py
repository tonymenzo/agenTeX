"""MCP server entry point for agenTeX.

Exposes the orchestral-defined tools in tools/agentex.py to Claude Code via
stdio MCP. Configured in .mcp.json at the project root.
"""
from __future__ import annotations

from orchestral.mcp import MCPServer

from agentex._guide import load_agent_guide
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
    tools = [
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
    ]
    guide = load_agent_guide()
    # MCPServer added `instructions=` in a yet-to-be-released patch. Until
    # that ships on PyPI, fall back to setting `instructions` on the
    # underlying mcp.server.Server after construction — it's read during
    # the initialize handshake, so setting it pre-run() still reaches the
    # client. Drop this fallback once the orchestral floor in pyproject
    # is bumped past the release that forwards the kwarg.
    try:
        server = MCPServer(
            tools=tools, name="agenTeX", version="0.1.2",
            instructions=guide, use_display_names=True,
        )
    except TypeError as e:
        if "instructions" not in str(e):
            raise
        server = MCPServer(
            tools=tools, name="agenTeX", version="0.1.2",
            use_display_names=True,
        )
        server._server.instructions = guide
    server.run()


if __name__ == "__main__":
    main()
