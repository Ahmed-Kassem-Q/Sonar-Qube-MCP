"""Exception hierarchy for the sonarqube-mcp server.

Every exception raised by :mod:`sonarqube_mcp` inherits from
:class:`SonarQubeMCPError`, so callers (and MCP tool handlers, which surface
exception messages directly to the calling LLM) can catch a single base class
when they don't need fine-grained handling.

Exceptions that represent a transient failure (network blips, timeouts,
HTTP 429/5xx) expose a ``retryable`` attribute so :mod:`sonarqube_mcp.client`
can implement a single, consistent retry policy instead of scattering
``try/except`` logic across call sites.
"""

from __future__ import annotations


class SonarQubeMCPError(Exception):
    """Base class for all errors raised by this package."""


class ConfigurationError(SonarQubeMCPError):
    """Raised when required configuration is missing or invalid."""


class SonarQubeConnectionError(SonarQubeMCPError):
    """Raised when the SonarQube/SonarCloud host could not be reached."""

    retryable = True


class SonarQubeTimeoutError(SonarQubeMCPError):
    """Raised when a request to SonarQube exceeded the configured timeout."""

    retryable = True


class SonarQubeAuthenticationError(SonarQubeMCPError):
    """Raised on HTTP 401/403 — invalid token, credentials, or permissions."""

    retryable = False


class SonarQubeNotFoundError(SonarQubeMCPError):
    """Raised when a project, issue, or resource does not exist (HTTP 404)."""

    retryable = False


class SonarQubeRateLimitError(SonarQubeMCPError):
    """Raised on HTTP 429. Retryable with backoff."""

    retryable = True

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class SonarQubeAPIError(SonarQubeMCPError):
    """Raised for any other non-2xx SonarQube API response.

    ``retryable`` is set based on the HTTP status code (5xx is retried,
    other 4xx codes are not, since retrying a malformed request will only
    reproduce the same error).
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        retryable: bool = False,
        response_body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.response_body = response_body


class RepositoryAccessError(SonarQubeMCPError):
    """Raised by the repository access tools (read_file, write_file, ...).

    Covers path-traversal attempts, missing files, size-limit violations,
    and the "write without confirmation" safety gate.
    """

    retryable = False
