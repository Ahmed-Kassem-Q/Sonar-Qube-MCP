"""Async SonarQube / SonarCloud Web API client.

Design goals:

* **Single source of truth for HTTP concerns** — auth, timeouts, retries,
  pagination, and error mapping all live here so :mod:`sonarqube_mcp.tools`
  and :mod:`sonarqube_mcp.resources` stay thin and declarative.
* **One connection pool for the process lifetime** — a single
  ``httpx.AsyncClient`` is created in the server's lifespan and reused by
  every request (see ``SonarQubeClient.__aenter__`` / ``aclose``), rather
  than opening a new client per call.
* **Predictable error handling** — every failure mode is translated into a
  typed exception from :mod:`sonarqube_mcp.exceptions` with a clear,
  actionable message, and a ``retryable`` flag drives a single retry policy
  implemented with `tenacity`.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from enum import Enum
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from sonarqube_mcp.config import Settings
from sonarqube_mcp.exceptions import (
    SonarQubeAPIError,
    SonarQubeAuthenticationError,
    SonarQubeConnectionError,
    SonarQubeMCPError,
    SonarQubeNotFoundError,
    SonarQubeRateLimitError,
    SonarQubeTimeoutError,
)
from sonarqube_mcp.models import (
    Issue,
    IssuesPage,
    Project,
    ProjectMetrics,
    ProjectsPage,
    QualityGateResult,
    Severity,
)

logger = logging.getLogger(__name__)

#: Safety valve so a pagination bug (or a server that never reports a
#: sane ``total``) can never spin forever.
_MAX_PAGES = 1000


def _is_retryable(exc: BaseException) -> bool:
    return bool(getattr(exc, "retryable", False))


def _severities_param(severities: Iterable[Severity | str] | None) -> str | None:
    if not severities:
        return None
    return ",".join(s.value if isinstance(s, Severity) else str(s) for s in severities)


def _enum_list_param(values: Iterable[Any] | None) -> str | None:
    if not values:
        return None
    return ",".join(v.value if isinstance(v, Enum) else str(v) for v in values)


class SonarQubeClient:
    """Thin, typed wrapper around the SonarQube/SonarCloud Web API."""

    def __init__(
        self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._settings = settings
        auth = settings.auth
        self._http = httpx.AsyncClient(
            base_url=settings.sonarqube_url,
            auth=auth,
            timeout=httpx.Timeout(settings.request_timeout_seconds),
            verify=settings.verify_ssl,
            headers={"Accept": "application/json"},
            transport=transport,
        )

    async def aclose(self) -> None:
        """Close the underlying connection pool. Call once at shutdown."""
        await self._http.aclose()

    async def __aenter__(self) -> SonarQubeClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # -- low-level request plumbing ------------------------------------------------

    def _org_param(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._settings.sonarqube_organization:
            params.setdefault("organization", self._settings.sonarqube_organization)
        return params

    async def _do_request(self, method: str, path: str, params: dict[str, Any] | None) -> Any:
        try:
            response = await self._http.request(method, path, params=params)
        except httpx.TimeoutException as exc:
            raise SonarQubeTimeoutError(
                f"Request to {path} timed out after "
                f"{self._settings.request_timeout_seconds}s: {exc}"
            ) from exc
        except httpx.TransportError as exc:
            raise SonarQubeConnectionError(
                f"Could not reach SonarQube host {self._settings.sonarqube_url}: {exc}"
            ) from exc

        if response.status_code == 401 or response.status_code == 403:
            raise SonarQubeAuthenticationError(
                f"SonarQube rejected the request to {path} with HTTP "
                f"{response.status_code}. Check SONARQUBE_TOKEN / "
                "SONARQUBE_USERNAME/SONARQUBE_PASSWORD and that the "
                "credential has permission to access this resource."
            )
        if response.status_code == 404:
            raise SonarQubeNotFoundError(f"Resource not found: {path} (params={params})")
        if response.status_code == 429:
            retry_after_header = response.headers.get("Retry-After")
            retry_after = float(retry_after_header) if retry_after_header else None
            raise SonarQubeRateLimitError(
                f"SonarQube rate-limited the request to {path}.", retry_after=retry_after
            )
        if response.status_code >= 500:
            raise SonarQubeAPIError(
                f"SonarQube returned HTTP {response.status_code} for {path}.",
                status_code=response.status_code,
                retryable=True,
                response_body=response.text[:2000],
            )
        if response.status_code >= 400:
            raise SonarQubeAPIError(
                f"SonarQube rejected the request to {path} with HTTP "
                f"{response.status_code}: {response.text[:500]}",
                status_code=response.status_code,
                retryable=False,
                response_body=response.text[:2000],
            )

        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise SonarQubeAPIError(
                f"SonarQube returned a non-JSON response for {path}.",
                status_code=response.status_code,
                retryable=False,
                response_body=response.text[:2000],
            ) from exc

    async def _request(
        self, method: str, path: str, params: Mapping[str, Any] | None = None
    ) -> Any:
        """Issue an HTTP request with the configured retry policy applied."""
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}

        retrying = retry(
            reraise=True,
            stop=stop_after_attempt(max(1, self._settings.max_retries + 1)),
            wait=wait_exponential(
                multiplier=self._settings.retry_backoff_seconds, min=0, max=30
            ),
            retry=retry_if_exception(_is_retryable),
        )
        wrapped = retrying(self._do_request)
        return await wrapped(method, path, clean_params)

    # -- projects -------------------------------------------------------------------

    async def search_projects(
        self, *, query: str | None = None, page: int = 1, page_size: int | None = None
    ) -> ProjectsPage:
        """Call ``GET /api/components/search`` for a single page of projects.

        Deliberately *not* ``api/projects/search``: that endpoint requires the
        global "Administer System" permission and returns HTTP 403 for ordinary
        users. ``api/components/search`` filtered to ``qualifiers=TRK`` lists the
        projects the credential can browse, needs no admin rights, and returns
        the same ``paging``/``components`` envelope.
        """
        params = self._org_param(
            {
                "qualifiers": "TRK",
                "p": page,
                "ps": page_size or self._settings.default_page_size,
                "q": query,
            }
        )
        data = await self._request("GET", "/api/components/search", params)
        return ProjectsPage.model_validate(data)

    async def get_all_projects(self, *, query: str | None = None) -> list[Project]:
        """Fetch every project visible to the configured credentials, paginating."""
        projects: list[Project] = []
        page = 1
        while page <= _MAX_PAGES:
            result = await self.search_projects(query=query, page=page)
            projects.extend(result.components)
            fetched = result.paging.page_index * result.paging.page_size
            if not result.components or fetched >= result.paging.total:
                break
            page += 1
        return projects

    # -- issues ----------------------------------------------------------------------

    async def search_issues(
        self,
        project_key: str,
        *,
        severities: Iterable[Severity] | None = None,
        types: Iterable[str] | None = None,
        statuses: Iterable[str] | None = None,
        page: int = 1,
        page_size: int | None = None,
    ) -> IssuesPage:
        """Call ``GET /api/issues/search`` for a single page of results."""
        params = self._org_param(
            {
                "componentKeys": project_key,
                "severities": _severities_param(severities),
                "types": _enum_list_param(types),
                "statuses": _enum_list_param(statuses),
                "p": page,
                "ps": page_size or self._settings.default_page_size,
            }
        )
        data = await self._request("GET", "/api/issues/search", params)
        return IssuesPage.model_validate(data)

    async def get_all_issues(
        self,
        project_key: str,
        *,
        severities: Iterable[Severity] | None = None,
        types: Iterable[str] | None = None,
        statuses: Iterable[str] | None = None,
        max_results: int | None = None,
    ) -> list[Issue]:
        """Fetch issues for a project, paginating until exhausted or ``max_results``."""
        issues: list[Issue] = []
        page = 1
        while page <= _MAX_PAGES:
            result = await self.search_issues(
                project_key,
                severities=severities,
                types=types,
                statuses=statuses,
                page=page,
            )
            issues.extend(result.issues)
            if max_results is not None and len(issues) >= max_results:
                return issues[:max_results]
            fetched = result.paging.page_index * result.paging.page_size
            if not result.issues or fetched >= result.paging.total:
                break
            page += 1
        return issues

    async def get_issue(self, issue_key: str) -> Issue:
        """Fetch a single issue by key via ``api/issues/search?issues=<key>``.

        SonarQube has no dedicated "get issue by key" endpoint in modern
        versions, so we filter ``issues/search`` down to one key instead.
        """
        params = self._org_param({"issues": issue_key, "additionalFields": "_all", "ps": 1})
        data = await self._request("GET", "/api/issues/search", params)
        page = IssuesPage.model_validate(data)
        if not page.issues:
            raise SonarQubeNotFoundError(f"No issue found with key '{issue_key}'.")
        return page.issues[0]

    # -- quality gate ------------------------------------------------------------------

    async def get_quality_gate_status(self, project_key: str) -> QualityGateResult:
        """Call ``GET /api/qualitygates/project_status``."""
        params = self._org_param({"projectKey": project_key})
        data = await self._request("GET", "/api/qualitygates/project_status", params)
        try:
            project_status = data["projectStatus"]
        except KeyError as exc:
            raise SonarQubeAPIError(
                "Unexpected response shape from api/qualitygates/project_status "
                f"(missing 'projectStatus'): {data!r}",
                status_code=200,
                retryable=False,
            ) from exc
        return QualityGateResult.model_validate(project_status)

    # -- metrics --------------------------------------------------------------------

    async def get_measures(self, project_key: str, metric_keys: Iterable[str]) -> ProjectMetrics:
        """Call ``GET /api/measures/component`` for the given metric keys."""
        params = self._org_param(
            {"component": project_key, "metricKeys": ",".join(metric_keys)}
        )
        data = await self._request("GET", "/api/measures/component", params)
        try:
            component = data["component"]
        except KeyError as exc:
            raise SonarQubeAPIError(
                "Unexpected response shape from api/measures/component "
                f"(missing 'component'): {data!r}",
                status_code=200,
                retryable=False,
            ) from exc
        return ProjectMetrics.model_validate(component)


__all__ = ["SonarQubeClient", "SonarQubeMCPError"]
