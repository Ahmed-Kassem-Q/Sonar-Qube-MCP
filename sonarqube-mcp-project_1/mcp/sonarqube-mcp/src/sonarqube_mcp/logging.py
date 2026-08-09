"""Logging configuration for sonarqube-mcp.

The server communicates with Claude Code over stdio using JSON-RPC, so
**stdout must stay pristine** — any stray print() or log line written to
stdout would corrupt the protocol stream. All logging in this package is
therefore configured to write to stderr only.
"""

from __future__ import annotations

import logging
import sys

_CONFIGURED = False

_LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S%z"


def configure_logging(level: str = "INFO") -> None:
    """Configure the root logger once, idempotently.

    Safe to call multiple times (e.g. from tests and from ``server.main``);
    subsequent calls only adjust the log level, they never attach duplicate
    handlers.
    """
    global _CONFIGURED

    root = logging.getLogger()
    normalized_level = getattr(logging, level.upper(), logging.INFO)

    if not _CONFIGURED:
        handler = logging.StreamHandler(stream=sys.stderr)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
        root.addHandler(handler)
        _CONFIGURED = True

        # Third-party libraries are noisy at INFO/DEBUG; keep them quiet
        # unless the operator explicitly asks for DEBUG output.
        for noisy in ("httpx", "httpcore", "hpack"):
            logging.getLogger(noisy).setLevel(logging.WARNING)

    root.setLevel(normalized_level)


def get_logger(name: str) -> logging.Logger:
    """Return a module-scoped logger. Call :func:`configure_logging` first."""
    return logging.getLogger(name)
