from __future__ import annotations

import pytest

from sonarqube_mcp.exceptions import RepositoryAccessError
from sonarqube_mcp.repo_access import (
    list_repo_files,
    read_file_content,
    search_repo_code,
    search_repo_files,
    write_file_content,
)


def test_read_file_returns_content(configured_env) -> None:
    assert read_file_content("src/app.py") == "def add(a, b):\n    return a + b\n"


def test_read_file_missing_raises(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        read_file_content("src/does_not_exist.py")


def test_read_file_rejects_path_traversal(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        read_file_content("../../etc/passwd")


def test_read_file_rejects_absolute_path_outside_root(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        read_file_content("/etc/passwd")


def test_write_file_creates_parent_dirs(configured_env) -> None:
    result = write_file_content("new/nested/file.txt", "hello\n")
    assert result.created is True
    assert result.bytes_written == 6
    assert read_file_content("new/nested/file.txt") == "hello\n"


def test_write_file_rejects_path_traversal(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        write_file_content("../escape.txt", "pwned")


def test_write_file_overwrite_reports_not_created(configured_env) -> None:
    result = write_file_content("src/app.py", "def add(a, b):\n    return a + b  # patched\n")
    assert result.created is False


def test_list_repo_files_filters_by_pattern(configured_env) -> None:
    files = list_repo_files(pattern="*.py")
    assert set(files) == {"src/app.py", "src/util.py"}


def test_list_repo_files_nonexistent_directory_raises(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        list_repo_files(directory="does/not/exist")


def test_search_repo_files_glob(configured_env) -> None:
    matches = search_repo_files("src/*.py")
    assert set(matches) == {"src/app.py", "src/util.py"}


def test_search_repo_code_finds_match(configured_env) -> None:
    matches = search_repo_code("SECRET")
    assert len(matches) == 1
    assert matches[0].path == "src/util.py"
    assert matches[0].line_number == 1


def test_search_repo_code_case_insensitive_by_default(configured_env) -> None:
    matches = search_repo_code("secret")
    assert len(matches) == 1


def test_search_repo_code_case_sensitive(configured_env) -> None:
    # The fixture file contains "SECRET" (upper) and "secrets" (lower, as a
    # substring of a different word) but never the exact-case token "Secret".
    matches = search_repo_code("Secret", case_sensitive=True)
    assert matches == []


def test_search_repo_code_empty_keyword_raises(configured_env) -> None:
    with pytest.raises(RepositoryAccessError):
        search_repo_code("")


def test_search_repo_code_respects_max_results(configured_env, repo_root) -> None:
    for i in range(10):
        (repo_root / f"gen_{i}.py").write_text("MATCHME\n")
    matches = search_repo_code("MATCHME", max_results=3)
    assert len(matches) == 3
