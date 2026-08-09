from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from sonarqube_mcp.client import SonarQubeClient
from sonarqube_mcp.config import get_settings
from sonarqube_mcp.exceptions import (
    SonarQubeAPIError,
    SonarQubeAuthenticationError,
    SonarQubeNotFoundError,
    SonarQubeRateLimitError,
)
from sonarqube_mcp.models import Severity


def _client(configured_env, handler: Callable[[httpx.Request], httpx.Response]) -> SonarQubeClient:
    settings = get_settings()
    return SonarQubeClient(settings, transport=httpx.MockTransport(handler))


@pytest.fixture
def projects_payload() -> dict:
    return {
        "paging": {"pageIndex": 1, "pageSize": 100, "total": 1},
        "components": [
            {
                "key": "proj1",
                "name": "Project One",
                "qualifier": "TRK",
                "visibility": "private",
                "lastAnalysisDate": "2026-08-01T12:00:00+0000",
            }
        ],
    }


async def test_get_all_projects_parses_response(configured_env, projects_payload) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        # Must be the non-admin components endpoint: api/projects/search
        # requires "Administer System" and 403s for ordinary users.
        assert request.url.path == "/api/components/search"
        assert request.url.params["qualifiers"] == "TRK"
        return httpx.Response(200, json=projects_payload)

    client = _client(configured_env, handler)
    projects = await client.get_all_projects()
    assert len(projects) == 1
    assert projects[0].key == "proj1"
    assert projects[0].name == "Project One"
    await client.aclose()


async def test_get_all_projects_paginates(configured_env) -> None:
    pages = {
        1: {
            "paging": {"pageIndex": 1, "pageSize": 1, "total": 2},
            "components": [{"key": "a", "name": "A"}],
        },
        2: {
            "paging": {"pageIndex": 2, "pageSize": 1, "total": 2},
            "components": [{"key": "b", "name": "B"}],
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("p", "1"))
        return httpx.Response(200, json=pages[page])

    client = _client(configured_env, handler)
    projects = await client.get_all_projects()
    assert [p.key for p in projects] == ["a", "b"]
    await client.aclose()


async def test_get_all_issues_filters_and_paginates(configured_env) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["componentKeys"] == "proj1"
        assert request.url.params["severities"] == "BLOCKER,CRITICAL"
        return httpx.Response(
            200,
            json={
                "total": 1,
                "paging": {"pageIndex": 1, "pageSize": 100, "total": 1},
                "issues": [
                    {
                        "key": "ISSUE1",
                        "rule": "python:S1481",
                        "severity": "BLOCKER",
                        "component": "proj1:src/app.py",
                        "project": "proj1",
                        "line": 2,
                        "message": "Unused variable",
                        "type": "CODE_SMELL",
                        "status": "OPEN",
                    }
                ],
            },
        )

    client = _client(configured_env, handler)
    issues = await client.get_all_issues(
        "proj1", severities=[Severity.BLOCKER, Severity.CRITICAL]
    )
    assert len(issues) == 1
    assert issues[0].key == "ISSUE1"
    assert issues[0].severity is Severity.BLOCKER
    await client.aclose()


async def test_get_issue_not_found_raises(configured_env) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "total": 0,
                "paging": {"pageIndex": 1, "pageSize": 1, "total": 0},
                "issues": [],
            },
        )

    client = _client(configured_env, handler)
    with pytest.raises(SonarQubeNotFoundError):
        await client.get_issue("does-not-exist")
    await client.aclose()


async def test_quality_gate_parses_conditions(configured_env) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "projectStatus": {
                    "status": "ERROR",
                    "conditions": [
                        {
                            "status": "ERROR",
                            "metricKey": "coverage",
                            "comparator": "LT",
                            "errorThreshold": "80",
                            "actualValue": "42",
                        }
                    ],
                }
            },
        )

    client = _client(configured_env, handler)
    gate = await client.get_quality_gate_status("proj1")
    assert gate.status.value == "ERROR"
    assert gate.conditions[0].metric_key == "coverage"
    await client.aclose()


async def test_measures_parses_component(configured_env) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["metricKeys"] == "bugs,coverage"
        return httpx.Response(
            200,
            json={
                "component": {
                    "key": "proj1",
                    "name": "P1",
                    "measures": [{"metric": "bugs", "value": "3"}],
                }
            },
        )

    client = _client(configured_env, handler)
    metrics = await client.get_measures("proj1", ["bugs", "coverage"])
    assert metrics.key == "proj1"
    assert metrics.measures[0].metric == "bugs"
    await client.aclose()


async def test_401_raises_authentication_error_without_retrying(configured_env) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, text="unauthorized")

    client = _client(configured_env, handler)
    with pytest.raises(SonarQubeAuthenticationError):
        await client.search_projects()
    assert calls["n"] == 1
    await client.aclose()


async def test_404_raises_not_found(configured_env) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    client = _client(configured_env, handler)
    with pytest.raises(SonarQubeNotFoundError):
        await client.search_projects()
    await client.aclose()


async def test_429_raises_rate_limit_error_and_is_retried(configured_env) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, text="slow down")

    client = _client(configured_env, handler)
    with pytest.raises(SonarQubeRateLimitError):
        await client.search_projects()
    # max_retries defaults to 3 -> 4 total attempts
    assert calls["n"] == 4
    await client.aclose()


async def test_500_is_retried_then_raises_api_error(configured_env, projects_payload) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, text="unavailable")

    client = _client(configured_env, handler)
    with pytest.raises(SonarQubeAPIError) as excinfo:
        await client.search_projects()
    assert excinfo.value.status_code == 503
    assert calls["n"] == 4
    await client.aclose()


async def test_500_eventually_succeeds_within_retry_budget(
    configured_env, projects_payload
) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, text="unavailable")
        return httpx.Response(200, json=projects_payload)

    client = _client(configured_env, handler)
    result = await client.search_projects()
    assert result.components[0].key == "proj1"
    assert calls["n"] == 3
    await client.aclose()


async def test_organization_param_included_when_configured(
    configured_env, monkeypatch: pytest.MonkeyPatch, projects_payload
) -> None:
    monkeypatch.setenv("SONARQUBE_ORGANIZATION", "my-org")
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["organization"] == "my-org"
        return httpx.Response(200, json=projects_payload)

    client = _client(configured_env, handler)
    await client.search_projects()
    await client.aclose()
    get_settings.cache_clear()
