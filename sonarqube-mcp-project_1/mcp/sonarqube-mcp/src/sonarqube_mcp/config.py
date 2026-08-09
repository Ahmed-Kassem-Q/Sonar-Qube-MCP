"""Typed, validated configuration for sonarqube-mcp.

All configuration is sourced from environment variables (optionally loaded
from a local ``.env`` file via pydantic-settings). See ``.env.example`` for
the full list of supported variables and their defaults.

Configuration is resolved once via :func:`get_settings`, which is memoized
with :func:`functools.lru_cache` so every part of the server shares a single
validated :class:`Settings` instance. Tests can call
:func:`get_settings.cache_clear` to force re-evaluation after mutating
environment variables.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from sonarqube_mcp.exceptions import ConfigurationError


class Settings(BaseSettings):
    """Runtime configuration for the SonarQube MCP server."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # --- SonarQube / SonarCloud connection ---------------------------------
    sonarqube_url: str = Field(alias="SONARQUBE_URL")
    sonarqube_token: SecretStr | None = Field(default=None, alias="SONARQUBE_TOKEN")
    sonarqube_username: str | None = Field(default=None, alias="SONARQUBE_USERNAME")
    sonarqube_password: SecretStr | None = Field(default=None, alias="SONARQUBE_PASSWORD")
    sonarqube_organization: str | None = Field(default=None, alias="SONARQUBE_ORGANIZATION")

    # --- HTTP client behavior -------------------------------------------------
    request_timeout_seconds: float = Field(default=30.0, alias="SONARQUBE_TIMEOUT_SECONDS", gt=0)
    max_retries: int = Field(default=3, alias="SONARQUBE_MAX_RETRIES", ge=0, le=10)
    retry_backoff_seconds: float = Field(
        default=0.5, alias="SONARQUBE_RETRY_BACKOFF_SECONDS", ge=0
    )
    default_page_size: int = Field(default=100, alias="SONARQUBE_PAGE_SIZE", ge=1, le=500)
    verify_ssl: bool = Field(default=True, alias="SONARQUBE_VERIFY_SSL")

    # --- Repository access tools ----------------------------------------------
    repo_root: Path = Field(default=Path("."), alias="MCP_REPO_ROOT")
    max_read_file_bytes: int = Field(default=2_000_000, alias="MCP_MAX_READ_FILE_BYTES", gt=0)
    max_write_file_bytes: int = Field(default=2_000_000, alias="MCP_MAX_WRITE_FILE_BYTES", gt=0)

    # --- Logging ----------------------------------------------------------------
    log_level: str = Field(default="INFO", alias="MCP_LOG_LEVEL")

    @field_validator("sonarqube_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("SONARQUBE_URL must not be empty")
        return value.rstrip("/")

    @field_validator("repo_root")
    @classmethod
    def _resolve_repo_root(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        normalized = value.strip().upper()
        if normalized not in allowed:
            raise ValueError(f"MCP_LOG_LEVEL must be one of {sorted(allowed)}, got {value!r}")
        return normalized

    @model_validator(mode="after")
    def _require_credentials(self) -> Settings:
        has_token = self.sonarqube_token is not None and bool(
            self.sonarqube_token.get_secret_value().strip()
        )
        has_basic_auth = bool(self.sonarqube_username) and self.sonarqube_password is not None
        if not has_token and not has_basic_auth:
            raise ValueError(
                "No SonarQube credentials configured. Set SONARQUBE_TOKEN "
                "(recommended) or both SONARQUBE_USERNAME and SONARQUBE_PASSWORD."
            )
        return self

    @property
    def auth(self) -> tuple[str, str] | None:
        """Return (username, password) tuple suitable for HTTP Basic auth.

        SonarQube/SonarCloud accept an API token as the Basic-auth username
        with an empty password — this works across all supported server
        versions, unlike the newer Bearer-token scheme.
        """
        if self.sonarqube_token is not None and self.sonarqube_token.get_secret_value().strip():
            return (self.sonarqube_token.get_secret_value(), "")
        if self.sonarqube_username and self.sonarqube_password is not None:
            return (self.sonarqube_username, self.sonarqube_password.get_secret_value())
        return None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the memoized, validated :class:`Settings` singleton.

    Raises:
        ConfigurationError: if required environment variables are missing
            or fail validation. The original pydantic ``ValidationError`` is
            chained for debugging.
    """
    try:
        return Settings()  # type: ignore[call-arg]
    except Exception as exc:  # pydantic.ValidationError, mainly
        raise ConfigurationError(
            "Invalid or missing sonarqube-mcp configuration. Check your .env "
            f"file or environment variables against .env.example. Details: {exc}"
        ) from exc
