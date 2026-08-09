from __future__ import annotations

import pytest
from pydantic import ValidationError

from sonarqube_mcp.config import Settings, get_settings
from sonarqube_mcp.exceptions import ConfigurationError


def test_requires_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io")
    monkeypatch.delenv("SONARQUBE_TOKEN", raising=False)
    monkeypatch.delenv("SONARQUBE_USERNAME", raising=False)
    monkeypatch.delenv("SONARQUBE_PASSWORD", raising=False)
    get_settings.cache_clear()
    with pytest.raises(ConfigurationError):
        get_settings()
    get_settings.cache_clear()


def test_token_auth_tuple(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io")
    monkeypatch.setenv("SONARQUBE_TOKEN", "abc123")
    monkeypatch.delenv("SONARQUBE_USERNAME", raising=False)
    settings = Settings()  # type: ignore[call-arg]
    assert settings.auth == ("abc123", "")


def test_basic_auth_tuple_used_when_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io")
    monkeypatch.delenv("SONARQUBE_TOKEN", raising=False)
    monkeypatch.setenv("SONARQUBE_USERNAME", "alice")
    monkeypatch.setenv("SONARQUBE_PASSWORD", "hunter2")
    settings = Settings()  # type: ignore[call-arg]
    assert settings.auth == ("alice", "hunter2")


def test_trailing_slash_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io/")
    monkeypatch.setenv("SONARQUBE_TOKEN", "abc123")
    settings = Settings()  # type: ignore[call-arg]
    assert settings.sonarqube_url == "https://sonarcloud.io"


def test_invalid_log_level_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io")
    monkeypatch.setenv("SONARQUBE_TOKEN", "abc123")
    monkeypatch.setenv("MCP_LOG_LEVEL", "NOT_A_LEVEL")
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_get_settings_is_memoized(configured_env) -> None:
    a = get_settings()
    b = get_settings()
    assert a is b
