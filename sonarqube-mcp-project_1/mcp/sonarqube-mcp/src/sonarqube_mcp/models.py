"""Pydantic models mirroring the subset of the SonarQube/SonarCloud Web API
this server consumes.

Field names use ``snake_case`` in Python and map to the API's ``camelCase``
JSON via ``Field(alias=...)``. ``populate_by_name=True`` on the shared base
class lets these models also be constructed from Python code using the
snake_case names (handy in tests).

All models returned from MCP tools double as the tool's structured output
schema (the MCP Python SDK derives an ``outputSchema`` from the return type
annotation), so keeping them precise and well-documented directly improves
what Claude sees about each tool's result shape.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class _SonarBaseModel(BaseModel):
    """Shared config: accept camelCase JSON, ignore fields we don't model."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class Severity(StrEnum):
    """SonarQube issue severity levels, from least to most severe."""

    INFO = "INFO"
    MINOR = "MINOR"
    MAJOR = "MAJOR"
    CRITICAL = "CRITICAL"
    BLOCKER = "BLOCKER"


class IssueType(StrEnum):
    """SonarQube issue categories."""

    CODE_SMELL = "CODE_SMELL"
    BUG = "BUG"
    VULNERABILITY = "VULNERABILITY"
    SECURITY_HOTSPOT = "SECURITY_HOTSPOT"


class IssueStatus(StrEnum):
    """SonarQube issue workflow states."""

    OPEN = "OPEN"
    CONFIRMED = "CONFIRMED"
    REOPENED = "REOPENED"
    RESOLVED = "RESOLVED"
    CLOSED = "CLOSED"
    TO_REVIEW = "TO_REVIEW"
    IN_REVIEW = "IN_REVIEW"
    REVIEWED = "REVIEWED"


class QualityGateStatus(StrEnum):
    """Overall SonarQube quality gate status."""

    OK = "OK"
    ERROR = "ERROR"
    WARN = "WARN"
    NONE = "NONE"


class Paging(_SonarBaseModel):
    """Pagination metadata returned by SonarQube list endpoints."""

    page_index: int = Field(alias="pageIndex")
    page_size: int = Field(alias="pageSize")
    total: int


class Project(_SonarBaseModel):
    """A single SonarQube project."""

    key: str
    name: str
    qualifier: str | None = None
    visibility: str | None = None
    last_analysis_date: datetime | None = Field(default=None, alias="lastAnalysisDate")


class ProjectsPage(_SonarBaseModel):
    """Response envelope for ``GET /api/components/search?qualifiers=TRK``."""

    paging: Paging
    components: list[Project] = Field(default_factory=list)


class TextRange(_SonarBaseModel):
    """Location of an issue within its source file."""

    start_line: int | None = Field(default=None, alias="startLine")
    end_line: int | None = Field(default=None, alias="endLine")
    start_offset: int | None = Field(default=None, alias="startOffset")
    end_offset: int | None = Field(default=None, alias="endOffset")


class Issue(_SonarBaseModel):
    """A single SonarQube issue (bug, vulnerability, code smell, or hotspot)."""

    key: str
    rule: str
    severity: Severity
    component: str
    project: str
    line: int | None = None
    text_range: TextRange | None = Field(default=None, alias="textRange")
    message: str
    type: IssueType
    status: IssueStatus
    resolution: str | None = None
    author: str | None = None
    tags: list[str] = Field(default_factory=list)
    creation_date: datetime | None = Field(default=None, alias="creationDate")
    update_date: datetime | None = Field(default=None, alias="updateDate")
    effort: str | None = None
    debt: str | None = None


class IssuesPage(_SonarBaseModel):
    """Response envelope for ``GET /api/issues/search``."""

    total: int
    paging: Paging
    issues: list[Issue] = Field(default_factory=list)


class QualityGateCondition(_SonarBaseModel):
    """A single condition (metric threshold) within a quality gate."""

    status: QualityGateStatus
    metric_key: str = Field(alias="metricKey")
    comparator: str
    error_threshold: str | None = Field(default=None, alias="errorThreshold")
    actual_value: str | None = Field(default=None, alias="actualValue")


class QualityGateResult(_SonarBaseModel):
    """Parsed ``projectStatus`` object from ``api/qualitygates/project_status``."""

    status: QualityGateStatus
    conditions: list[QualityGateCondition] = Field(default_factory=list)
    ignored_conditions: bool | None = Field(default=None, alias="ignoredConditions")


class Measure(_SonarBaseModel):
    """A single metric measurement for a project."""

    metric: str
    value: str | None = None
    best_value: bool | None = Field(default=None, alias="bestValue")


class ProjectMetrics(_SonarBaseModel):
    """Parsed ``component`` object from ``api/measures/component``."""

    key: str
    name: str | None = None
    measures: list[Measure] = Field(default_factory=list)


#: Default set of metrics fetched by ``get_project_metrics`` when the caller
#: does not specify ``metric_keys`` explicitly. Covers the headline
#: reliability / security / maintainability / coverage / size indicators.
DEFAULT_METRIC_KEYS: list[str] = [
    "bugs",
    "vulnerabilities",
    "code_smells",
    "security_hotspots",
    "coverage",
    "duplicated_lines_density",
    "ncloc",
    "reliability_rating",
    "security_rating",
    "sqale_rating",
    "alert_status",
]


class WriteResult(BaseModel):
    """Result of a successful :func:`sonarqube_mcp.tools.write_file` call."""

    path: str
    bytes_written: int
    created: bool


class CodeSearchMatch(BaseModel):
    """A single line matching a :func:`sonarqube_mcp.tools.search_code` query."""

    path: str
    line_number: int
    line_text: str
