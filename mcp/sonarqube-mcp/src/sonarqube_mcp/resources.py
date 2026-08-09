"""Read-only MCP resources exposing SonarQube data as addressable URIs.

Resources are for passive context — "what does this project's data look
like right now" — as opposed to tools, which represent actions. All four
resources here return ``application/json`` text built from
:class:`sonarqube_mcp.client.SonarQubeClient`.

Note on Context: the MCP Python SDK does not support injecting
:class:`~mcp.server.mcpserver.Context` into a *static* resource (one with no
``{placeholder}`` in its URI, such as ``sonar://projects``) — only resource
*templates* can receive it. Rather than have the ``sonar://projects``
resource use the pooled lifespan client while its siblings use a different
mechanism, every resource here opens its own short-lived
:class:`SonarQubeClient` for the single call. Resources are read
infrequently compared to tools, so the extra connection setup is a
worthwhile simplicity trade-off; the pooled client from the server lifespan
is still used for every tool call (see :mod:`sonarqube_mcp.tools`).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sonarqube_mcp.client import SonarQubeClient
from sonarqube_mcp.config import get_settings
from sonarqube_mcp.exceptions import SonarQubeNotFoundError
from sonarqube_mcp.models import DEFAULT_METRIC_KEYS
from sonarqube_mcp.server import mcp


@asynccontextmanager
async def _client() -> AsyncIterator[SonarQubeClient]:
    client = SonarQubeClient(get_settings())
    try:
        yield client
    finally:
        await client.aclose()


def _to_json(payload: object) -> str:
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump(mode="json")
    elif isinstance(payload, list):
        payload = [
            item.model_dump(mode="json") if hasattr(item, "model_dump") else item
            for item in payload
        ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


@mcp.resource(
    "sonar://projects",
    name="SonarQube projects",
    description="All SonarQube projects visible to the configured credentials.",
    mime_type="application/json",
)
async def projects_resource() -> str:
    async with _client() as client:
        projects = await client.get_all_projects()
        return _to_json(projects)


@mcp.resource(
    "sonar://projects/{project_key}",
    name="SonarQube project details",
    description="Details for a single SonarQube project.",
    mime_type="application/json",
)
async def project_resource(project_key: str) -> str:
    async with _client() as client:
        matches = await client.get_all_projects(query=project_key)
        project = next((p for p in matches if p.key == project_key), None)
        if project is None:
            raise SonarQubeNotFoundError(f"No project found with key '{project_key}'.")
        return _to_json(project)


@mcp.resource(
    "sonar://projects/{project_key}/issues",
    name="SonarQube project issues",
    description="All open issues for a single SonarQube project.",
    mime_type="application/json",
)
async def project_issues_resource(project_key: str) -> str:
    async with _client() as client:
        issues = await client.get_all_issues(project_key)
        return _to_json(issues)


@mcp.resource(
    "sonar://projects/{project_key}/metrics",
    name="SonarQube project metrics",
    description="Headline code quality metrics for a single SonarQube project.",
    mime_type="application/json",
)
async def project_metrics_resource(project_key: str) -> str:
    async with _client() as client:
        metrics = await client.get_measures(project_key, DEFAULT_METRIC_KEYS)
        return _to_json(metrics)
