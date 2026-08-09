from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sonarqube_mcp.config import get_settings


@pytest.fixture(autouse=True)
def isolate_from_dotenv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Run every test from an empty directory.

    ``Settings`` loads ``env_file=".env"`` relative to the current working
    directory, so a developer's real ``mcp/sonarqube-mcp/.env`` would otherwise
    leak live credentials into tests that deliberately unset them.
    """
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def repo_root(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def add(a, b):\n    return a + b\n")
    (tmp_path / "src" / "util.py").write_text("SECRET = 'do not print secrets'\n")
    (tmp_path / "README.md").write_text("# fake project\n")
    return tmp_path


@pytest.fixture
def configured_env(monkeypatch: pytest.MonkeyPatch, repo_root: Path) -> Iterator[Path]:
    """Set required env vars and clear the memoized Settings singleton."""
    monkeypatch.setenv("SONARQUBE_URL", "https://sonarcloud.io")
    monkeypatch.setenv("SONARQUBE_TOKEN", "test-token")
    monkeypatch.setenv("MCP_REPO_ROOT", str(repo_root))
    # Make sure no stray .env file in the repo influences the test.
    monkeypatch.chdir(repo_root)
    get_settings.cache_clear()
    yield repo_root
    get_settings.cache_clear()
