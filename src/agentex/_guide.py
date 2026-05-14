"""Load the agent guide shipped as package data.

`templates/AGENT_GUIDE.md` is the single source of truth for "how to drive
agenTeX as an agent". It's served three ways: (1) to external agents over MCP
as the server's `instructions` field; (2) to external agents as a copied
`AGENTS.md` in the user's project, written by `agentex init`; (3) to the
in-process comment-panel agent as a system-prompt preamble.

Reading via `importlib.resources` so it works equally well from a source
checkout, an installed wheel, or a zipapp.
"""
from __future__ import annotations

from functools import lru_cache
from importlib import resources


@lru_cache(maxsize=1)
def load_agent_guide() -> str:
    return resources.files("agentex.templates").joinpath("AGENT_GUIDE.md").read_text(
        encoding="utf-8"
    )
