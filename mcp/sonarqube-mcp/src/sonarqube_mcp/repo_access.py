"""Sandboxed filesystem helpers backing the repository-access MCP tools.

Every function here resolves paths against ``settings.repo_root`` and
refuses to touch anything outside it, so a malformed or malicious ``path``
argument (e.g. ``../../etc/passwd`` or an absolute path) can never escape the
connected repository. This module contains pure filesystem logic; the
``@mcp.tool()`` wrappers in :mod:`sonarqube_mcp.tools` are thin adapters over
it (kept separate so the safety-critical path logic has a single, easily
reviewed and testable home).
"""

from __future__ import annotations

import fnmatch
from collections.abc import Iterator
from pathlib import Path

from sonarqube_mcp.config import Settings, get_settings
from sonarqube_mcp.exceptions import RepositoryAccessError
from sonarqube_mcp.models import CodeSearchMatch, WriteResult

#: Directories that are never walked — build artifacts, VCS internals, and
#: dependency caches that are typically huge, binary-heavy, and irrelevant
#: to source-level review.
IGNORED_DIR_NAMES: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "venv",
        "node_modules",
        "dist",
        "build",
        ".idea",
        ".vscode",
        "bin",
        "obj",
    }
)

#: Files above this size are skipped by search_code (binary/generated-file heuristic).
_MAX_SEARCH_FILE_BYTES = 5_000_000


def _resolve_path(relative_path: str, *, settings: Settings | None = None) -> Path:
    """Resolve ``relative_path`` against the configured repo root.

    Raises:
        RepositoryAccessError: if the resolved path would fall outside the
            repository root (path traversal, symlink escape, absolute path
            pointing elsewhere, etc.).
    """
    settings = settings or get_settings()
    root = settings.repo_root
    candidate = (root / relative_path).expanduser().resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise RepositoryAccessError(
            f"Path '{relative_path}' resolves outside the connected repository "
            f"root ({root}) and is not allowed."
        ) from exc
    return candidate


def read_file_content(relative_path: str) -> str:
    """Read a text file within the repository root.

    Raises:
        RepositoryAccessError: on path-traversal, missing file, directory
            path, non-UTF-8 content, or a file larger than
            ``MCP_MAX_READ_FILE_BYTES``.
    """
    settings = get_settings()
    path = _resolve_path(relative_path, settings=settings)

    if not path.exists():
        raise RepositoryAccessError(f"File not found: {relative_path}")
    if path.is_dir():
        raise RepositoryAccessError(f"'{relative_path}' is a directory, not a file.")

    size = path.stat().st_size
    if size > settings.max_read_file_bytes:
        raise RepositoryAccessError(
            f"'{relative_path}' is {size} bytes, exceeding the "
            f"{settings.max_read_file_bytes}-byte read limit (MCP_MAX_READ_FILE_BYTES)."
        )

    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise RepositoryAccessError(
            f"'{relative_path}' does not appear to be a UTF-8 text file."
        ) from exc


def write_file_content(relative_path: str, content: str) -> WriteResult:
    """Write ``content`` to a file within the repository root, creating parents.

    Callers (the ``write_file`` MCP tool) are responsible for enforcing the
    "ask the user first" safety gate — this function performs the write
    unconditionally once called.

    Raises:
        RepositoryAccessError: on path-traversal, a target that is an
            existing directory, or content larger than
            ``MCP_MAX_WRITE_FILE_BYTES``.
    """
    settings = get_settings()
    path = _resolve_path(relative_path, settings=settings)

    encoded = content.encode("utf-8")
    if len(encoded) > settings.max_write_file_bytes:
        raise RepositoryAccessError(
            f"Refusing to write {len(encoded)} bytes to '{relative_path}': exceeds the "
            f"{settings.max_write_file_bytes}-byte write limit (MCP_MAX_WRITE_FILE_BYTES)."
        )
    if path.is_dir():
        raise RepositoryAccessError(f"'{relative_path}' is a directory, not a file.")

    created = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return WriteResult(
        path=path.relative_to(settings.repo_root).as_posix(),
        bytes_written=len(encoded),
        created=created,
    )


def _iter_files(root: Path, *, start_dir: Path) -> Iterator[Path]:
    for candidate in start_dir.rglob("*"):
        if not candidate.is_file():
            continue
        if any(part in IGNORED_DIR_NAMES for part in candidate.relative_to(root).parts[:-1]):
            continue
        yield candidate


def list_repo_files(
    directory: str = ".",
    pattern: str = "*",
    recursive: bool = True,
    max_results: int = 2000,
) -> list[str]:
    """List files under ``directory`` (relative to the repo root).

    ``pattern`` is a filename glob (fnmatch-style, e.g. ``*.py``). Common
    VCS/build/dependency directories (see :data:`IGNORED_DIR_NAMES`) are
    always skipped.
    """
    settings = get_settings()
    start = _resolve_path(directory, settings=settings)
    if not start.exists():
        raise RepositoryAccessError(f"Directory not found: {directory}")
    if not start.is_dir():
        raise RepositoryAccessError(f"'{directory}' is not a directory.")

    results: list[str] = []
    iterator = start.rglob("*") if recursive else start.glob("*")
    for candidate in iterator:
        if not candidate.is_file():
            continue
        rel_parts = candidate.relative_to(settings.repo_root).parts[:-1]
        if any(part in IGNORED_DIR_NAMES for part in rel_parts):
            continue
        if not fnmatch.fnmatch(candidate.name, pattern):
            continue
        results.append(candidate.relative_to(settings.repo_root).as_posix())
        if len(results) >= max_results:
            break
    return sorted(results)


def search_repo_files(pattern: str, recursive: bool = True, max_results: int = 2000) -> list[str]:
    """Find files whose *path* matches a glob pattern (e.g. ``**/test_*.py``)."""
    settings = get_settings()
    root = settings.repo_root
    iterator = root.rglob(pattern) if recursive else root.glob(pattern)

    results: list[str] = []
    for candidate in iterator:
        if not candidate.is_file():
            continue
        rel_parts = candidate.relative_to(root).parts[:-1]
        if any(part in IGNORED_DIR_NAMES for part in rel_parts):
            continue
        results.append(candidate.relative_to(root).as_posix())
        if len(results) >= max_results:
            break
    return sorted(results)


def search_repo_code(
    keyword: str,
    file_pattern: str = "*",
    case_sensitive: bool = False,
    max_results: int = 200,
) -> list[CodeSearchMatch]:
    """Grep-style search for ``keyword`` across text files under the repo root."""
    if not keyword:
        raise RepositoryAccessError("search_code requires a non-empty 'keyword'.")

    settings = get_settings()
    root = settings.repo_root
    needle = keyword if case_sensitive else keyword.lower()

    matches: list[CodeSearchMatch] = []
    for candidate in _iter_files(root, start_dir=root):
        if not fnmatch.fnmatch(candidate.name, file_pattern):
            continue
        try:
            if candidate.stat().st_size > _MAX_SEARCH_FILE_BYTES:
                continue
            text = candidate.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable file — skip rather than fail the whole search

        for line_number, line in enumerate(text.splitlines(), start=1):
            haystack = line if case_sensitive else line.lower()
            if needle in haystack:
                matches.append(
                    CodeSearchMatch(
                        path=candidate.relative_to(root).as_posix(),
                        line_number=line_number,
                        line_text=line.strip(),
                    )
                )
                if len(matches) >= max_results:
                    return matches
    return matches
