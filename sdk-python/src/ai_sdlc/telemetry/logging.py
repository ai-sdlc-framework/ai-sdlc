"""Structured logging for AI-SDLC Framework."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

LogLevel = Literal["debug", "info", "warn", "error"]


@dataclass(frozen=True)
class LogEntry:
    level: LogLevel
    message: str
    timestamp: str
    logger: str | None = None
    attributes: dict[str, Any] | None = None
    error: str | None = None


class StructuredLogger(Protocol):
    def debug(self, msg: str, attrs: dict[str, Any] | None = None) -> None: ...
    def info(self, msg: str, attrs: dict[str, Any] | None = None) -> None: ...
    def warn(self, msg: str, attrs: dict[str, Any] | None = None) -> None: ...
    def error(
        self, msg: str, attrs: dict[str, Any] | None = None, err: Exception | None = None
    ) -> None: ...


class BufferLogger(StructuredLogger, Protocol):
    def get_entries(self) -> list[LogEntry]: ...
    def clear(self) -> None: ...


def _create_entry(
    level: LogLevel,
    message: str,
    logger: str | None = None,
    attrs: dict[str, Any] | None = None,
    err: Exception | None = None,
) -> LogEntry:
    return LogEntry(
        level=level,
        message=message,
        timestamp=datetime.now(UTC).isoformat(),
        logger=logger,
        attributes=attrs,
        error=str(err) if err else None,
    )


class _NoOpLogger:
    def debug(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        pass

    def info(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        pass

    def warn(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        pass

    def error(
        self, msg: str, attrs: dict[str, Any] | None = None, err: Exception | None = None
    ) -> None:
        pass


class _BufferLoggerImpl:
    def __init__(self, name: str | None = None) -> None:
        self._name = name
        self._entries: list[LogEntry] = []

    def debug(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._entries.append(_create_entry("debug", msg, self._name, attrs))

    def info(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._entries.append(_create_entry("info", msg, self._name, attrs))

    def warn(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._entries.append(_create_entry("warn", msg, self._name, attrs))

    def error(
        self, msg: str, attrs: dict[str, Any] | None = None, err: Exception | None = None
    ) -> None:
        self._entries.append(_create_entry("error", msg, self._name, attrs, err))

    def get_entries(self) -> list[LogEntry]:
        return list(self._entries)

    def clear(self) -> None:
        self._entries.clear()


class _ConsoleLogger:
    def __init__(self, name: str | None = None) -> None:
        self._name = name

    def _write(
        self,
        level: LogLevel,
        msg: str,
        attrs: dict[str, Any] | None = None,
        err: Exception | None = None,
    ) -> None:
        entry = _create_entry(level, msg, self._name, attrs, err)
        line = json.dumps({
            "level": entry.level,
            "message": entry.message,
            "timestamp": entry.timestamp,
            "logger": entry.logger,
            "attributes": entry.attributes,
            "error": entry.error,
        })
        stream = sys.stderr if level in ("warn", "error") else sys.stdout
        print(line, file=stream)

    def debug(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._write("debug", msg, attrs)

    def info(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._write("info", msg, attrs)

    def warn(self, msg: str, attrs: dict[str, Any] | None = None) -> None:
        self._write("warn", msg, attrs)

    def error(
        self, msg: str, attrs: dict[str, Any] | None = None, err: Exception | None = None
    ) -> None:
        self._write("error", msg, attrs, err)


def create_no_op_logger() -> StructuredLogger:
    """Create a no-op logger that silently discards all messages."""
    return _NoOpLogger()


def create_buffer_logger(name: str | None = None) -> _BufferLoggerImpl:
    """Create a buffer logger that stores entries in-memory for testing."""
    return _BufferLoggerImpl(name)


def create_console_logger(name: str | None = None) -> StructuredLogger:
    """Create a console logger that writes JSON-formatted structured logs."""
    return _ConsoleLogger(name)
