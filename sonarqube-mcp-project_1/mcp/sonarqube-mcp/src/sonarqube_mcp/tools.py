"""MCP tools exposed by sonarqube-mcp.

Two families of tools live here:

1. **SonarQube tools** (``get_projects``, ``get_project_issues``,
   ``get_critical_issues``, ``get_quality_gate``, ``get_issue_details``,
   ``get_project_metrics``) — thin, validating wrappers around
   :class:`sonarqube_mcp.client.SonarQubeClient`.
2. **Repository access tools** (``read_file``, ``write_file``,
   ``list_files``, ``search_code``, ``search_files``) — thin wrappers around
   :mod:`sonarqube_mcp.repo_access`, sandboxed to ``MCP_REPO_ROOT``.

Per the project's safety rules, ``write_file`` never writes on its first
call: it requires an explicit ``confirmed=True`` argument, which callers
(Claude, guided by the ``fix_issue`` prompt and the ``fix-sonarqube-issues``
skill) only pass after the user has seen the proposed diff and approved it.
"""

from __future__ import annotations

from enum import StrEnum

from mcp.server.mcpserver import Context

from sonarqube_mcp.exceptions import RepositoryAccessError
from sonarqube_mcp.models import (
    DEFAULT_METRIC_KEYS,
    CodeSearchMatch,
    Issue,
    IssueStatus,
    IssueType,
    Project,
    ProjectMetrics,
    QualityGateResult,
    Severity,
    WriteResult,
)
from sonarqube_mcp.repo_access import (
    list_repo_files,
    read_file_content,
    search_repo_code,
    search_repo_files,
    write_file_content,
)
from sonarqube_mcp.server import AppContext, get_client, mcp


def _parse_enum[EnumT: StrEnum](
    enum_cls: type[EnumT], raw: str | None, field_name: str
) -> EnumT | None:
    if raw is None:
        return None
    try:
        return enum_cls(raw.strip().upper())
    except ValueError as exc:
        valid = ", ".join(member.value for member in enum_cls)
        raise ValueError(f"Invalid {field_name} '{raw}'. Valid values: {valid}") from exc


def _parse_enum_list[EnumT: StrEnum](
    enum_cls: type[EnumT], raw: list[str] | None, field_name: str
) -> list[EnumT] | None:
    if not raw:
        return None
    return [
        member
        for value in raw
        if (member := _parse_enum(enum_cls, value, field_name)) is not None
    ]


# ---------------------------------------------------------------------------
# SonarQube tools
# ---------------------------------------------------------------------------


@mcp.tool()
async def get_projects(ctx: Context[AppContext], query: str | None = None) -> list[Project]:
    """List SonarQube projects visible to the configured credentials.

    Args:
        query: Optional case-insensitive substring to filter projects by
            name or key (matches the SonarQube UI's project search box).
    """
    client = get_client(ctx)
    return await client.get_all_projects(query=query)


@mcp.tool()
async def get_project_issues(
    ctx: Context[AppContext],
    project_key: str,
    severity: str | None = None,
    issue_type: str | None = None,
    status: str | None = None,
    max_results: int = 200,
) -> list[Issue]:
    """Retrieve issues for a SonarQube project, with optional filters.

    Args:
        project_key: The SonarQube project key (e.g. ``my-org_my-repo``).
        severity: Optional single severity filter — one of INFO, MINOR,
            MAJOR, CRITICAL, BLOCKER.
        issue_type: Optional single type filter — one of CODE_SMELL, BUG,
            VULNERABILITY, SECURITY_HOTSPOT.
        status: Optional single status filter — one of OPEN, CONFIRMED,
            REOPENED, RESOLVED, CLOSED, TO_REVIEW, IN_REVIEW, REVIEWED.
        max_results: Upper bound on the number of issues returned
            (pagination stops once this is reached). Defaults to 200.
    """
    client = get_client(ctx)
    severities = _parse_enum_list(Severity, [severity] if severity else None, "severity")
    types = _parse_enum_list(IssueType, [issue_type] if issue_type else None, "issue_type")
    statuses = _parse_enum_list(IssueStatus, [status] if status else None, "status")
    return await client.get_all_issues(
        project_key,
        severities=severities,
        types=types,
        statuses=statuses,
        max_results=max_results,
    )


@mcp.tool()
async def get_critical_issues(
    ctx: Context[AppContext], project_key: str, max_results: int = 200
) -> list[Issue]:
    """Retrieve only BLOCKER and CRITICAL severity issues for a project.

    Use this to triage the highest-priority findings first, ahead of a
    release or before starting a broader cleanup pass.

    Args:
        project_key: The SonarQube project key.
        max_results: Upper bound on the number of issues returned.
    """
    client = get_client(ctx)
    return await client.get_all_issues(
        project_key,
        severities=[Severity.BLOCKER, Severity.CRITICAL],
        max_results=max_results,
    )


@mcp.tool()
async def get_quality_gate(ctx: Context[AppContext], project_key: str) -> QualityGateResult:
    """Get the current Quality Gate status and its per-metric conditions.

    Args:
        project_key: The SonarQube project key.
    """
    client = get_client(ctx)
    return await client.get_quality_gate_status(project_key)


@mcp.tool()
async def get_issue_details(ctx: Context[AppContext], issue_key: str) -> Issue:
    """Get full details for a single SonarQube issue by its key.

    Args:
        issue_key: The SonarQube issue key (e.g. ``AYg1abcXYZ123``).
    """
    client = get_client(ctx)
    return await client.get_issue(issue_key)


@mcp.tool()
async def get_project_metrics(
    ctx: Context[AppContext], project_key: str, metric_keys: list[str] | None = None
) -> ProjectMetrics:
    """Get code quality metrics for a project (bugs, vulnerabilities, coverage, etc.).

    Args:
        project_key: The SonarQube project key.
        metric_keys: Optional explicit list of SonarQube metric keys to
            fetch (see the "Metrics" page of the SonarQube Web API docs).
            Defaults to a sensible set covering reliability, security,
            maintainability, coverage, duplication, size, and the overall
            quality-gate status.
    """
    client = get_client(ctx)
    return await client.get_measures(project_key, metric_keys or DEFAULT_METRIC_KEYS)


# ---------------------------------------------------------------------------
# Repository access tools
# ---------------------------------------------------------------------------


@mcp.tool()
def read_file(path: str) -> str:
    """Read and return the UTF-8 text contents of a file in the connected repository.

    Args:
        path: Path relative to the repository root (``MCP_REPO_ROOT``).
            Absolute paths and ``..`` segments that escape the repository
            root are rejected.
    """
    return read_file_content(path)


@mcp.tool()
def write_file(path: str, content: str, confirmed: bool = False) -> WriteResult:
    """Write text content to a file in the connected repository.

    SAFETY RULE: this tool refuses to write unless ``confirmed=True`` is
    passed explicitly. The correct workflow is: show the issue, explain the
    root cause, show the proposed diff to the user, and only call this tool
    with ``confirmed=True`` after the user has explicitly approved it.

    Args:
        path: Path relative to the repository root. Parent directories are
            created automatically. Absolute paths and ``..`` segments that
            escape the repository root are rejected.
        content: The full new file content to write (this replaces the
            entire file — always read the current content first and edit
            it, rather than guessing at partial content).
        confirmed: Must be explicitly set to True. Defaults to False so an
            accidental or premature call never modifies source code.
    """
    if not confirmed:
        raise RepositoryAccessError(
            "Refusing to write without confirmation. Show the issue, its root "
            "cause, and the proposed diff to the user, obtain explicit "
            "confirmation, then call write_file again with confirmed=True."
        )
    return write_file_content(path, content)


@mcp.tool()
def list_files(
    directory: str = ".", pattern: str = "*", recursive: bool = True, max_results: int = 2000
) -> list[str]:
    """List files in the connected repository, relative to the repository root.

    Args:
        directory: Directory to list, relative to the repository root.
            Defaults to the repository root itself.
        pattern: Filename glob filter (e.g. ``*.py``). Defaults to ``*``
            (all files).
        recursive: Whether to descend into subdirectories. Defaults to True.
        max_results: Upper bound on the number of paths returned.
    """
    return list_repo_files(directory, pattern=pattern, recursive=recursive, max_results=max_results)


@mcp.tool()
def search_code(
    keyword: str,
    file_pattern: str = "*",
    case_sensitive: bool = False,
    max_results: int = 200,
) -> list[CodeSearchMatch]:
    """Search file contents in the connected repository for a keyword (grep-style).

    Args:
        keyword: Text to search for within each line of each matching file.
        file_pattern: Filename glob to restrict which files are searched
            (e.g. ``*.py``, ``*.ts``). Defaults to ``*`` (all text files).
        case_sensitive: Whether the search is case-sensitive. Defaults to
            False.
        max_results: Upper bound on the number of matching lines returned.
    """
    return search_repo_code(
        keyword, file_pattern=file_pattern, case_sensitive=case_sensitive, max_results=max_results
    )


@mcp.tool()
def search_files(pattern: str, recursive: bool = True, max_results: int = 2000) -> list[str]:
    """Find files whose path matches a glob pattern (e.g. ``**/test_*.py``).

    Unlike ``list_files`` (which filters by filename within a directory),
    ``search_files`` matches the glob against the full relative path, so it
    also supports patterns like ``src/**/*.py``.

    Args:
        pattern: A glob pattern, relative to the repository root.
        recursive: Whether ``**`` segments in the pattern may match across
            directory boundaries. Defaults to True.
        max_results: Upper bound on the number of paths returned.
    """
    return search_repo_files(pattern, recursive=recursive, max_results=max_results)
