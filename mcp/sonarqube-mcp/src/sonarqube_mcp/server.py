"""Entry point and application wiring for the sonarqube-mcp MCP server.

This module owns the single :class:`~mcp.server.mcpserver.MCPServer`
instance (``mcp``) and its typed lifespan, which opens one pooled
:class:`~sonarqube_mcp.client.SonarQubeClient` for the life of the process
and closes it cleanly on shutdown.

Import order matters here and is intentional: ``mcp`` and
:func:`get_client` are defined *before* the ``tools`` / ``resources`` /
``prompts`` modules are imported at the bottom of the file. Those modules do
``from sonarqube_mcp.server import mcp`` at their own top level; because
Python has already bound ``mcp`` on this module by the time that import
runs, the apparent circular import resolves cleanly (the same pattern Flask
blueprints use).
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from mcp.server.mcpserver import Context, MCPServer

from sonarqube_mcp.client import SonarQubeClient
from sonarqube_mcp.config import get_settings
from sonarqube_mcp.exceptions import ConfigurationError
from sonarqube_mcp.logging import configure_logging, get_logger

logger = get_logger(__name__)


@dataclass
class AppContext:
    """Object shared across every request for the life of the server process."""

    client: SonarQubeClient


@asynccontextmanager
async def app_lifespan(server: MCPServer[AppContext]) -> AsyncIterator[AppContext]:
    """Open one pooled SonarQube HTTP client at startup, close it at shutdown."""
    settings = get_settings()
    client = SonarQubeClient(settings)
    logger.info("SonarQube MCP server starting up (target=%s)", settings.sonarqube_url)
    try:
        yield AppContext(client=client)
    finally:
        logger.info("SonarQube MCP server shutting down")
        await client.aclose()


mcp: MCPServer[AppContext] = MCPServer(
    "sonarqube-mcp",
    version="0.1.0",
    instructions=(
        "Tools for querying SonarQube/SonarCloud (projects, issues, quality gates, "
        "metrics) and for safely reading and writing files in the connected "
        "repository. write_file always requires an explicit confirmed=True from the "
        "caller after the user has approved a shown diff — never call it with "
        "confirmed=True on the first attempt."
    ),
    lifespan=app_lifespan,
)


def get_client(ctx: Context[AppContext]) -> SonarQubeClient:
    """Return the shared :class:`SonarQubeClient` for the current request."""
    return ctx.request_context.lifespan_context.client


# Import the modules that register tools/resources/prompts on `mcp` via
# decorators. This must happen after `mcp` and `get_client` are defined
# above (see the module docstring for why this isn't a real circular import).
from sonarqube_mcp import prompts, resources, tools  # noqa: E402,F401


def main() -> None:
    """Console-script entry point (``sonarqube-mcp``). Runs over stdio."""
    try:
        settings = get_settings()
    except ConfigurationError as exc:
        # Fail fast and loud on stderr — Claude Code shows this if the
        # server can't start, which is far more useful than a stack trace.
        print(f"sonarqube-mcp failed to start: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    configure_logging(settings.log_level)
    logger.info("Repository tools sandboxed to: %s", settings.repo_root)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
