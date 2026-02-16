"""In-memory audit sink for testing."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .types import AuditEntry, AuditFilter


def _matches_filter(entry: AuditEntry, f: AuditFilter) -> bool:
    if f.actor and entry.actor != f.actor:
        return False
    if f.action and entry.action != f.action:
        return False
    if f.resource and entry.resource != f.resource:
        return False
    if f.decision and entry.decision != f.decision:
        return False
    if f.from_ and entry.timestamp < f.from_:
        return False
    return not (f.to and entry.timestamp > f.to)


class InMemoryAuditSink:
    def __init__(self) -> None:
        self._entries: list[AuditEntry] = []
        self._closed = False

    def write(self, entry: AuditEntry) -> None:
        if self._closed:
            raise RuntimeError("AuditSink is closed")
        self._entries.append(entry)

    async def query(self, filter: AuditFilter) -> list[AuditEntry]:
        if self._closed:
            raise RuntimeError("AuditSink is closed")
        return [e for e in self._entries if _matches_filter(e, filter)]

    async def rotate(self) -> None:
        self._entries.clear()

    async def close(self) -> None:
        self._closed = True

    def get_entries(self) -> list[AuditEntry]:
        return list(self._entries)

    def get_entry_count(self) -> int:
        return len(self._entries)


def create_in_memory_audit_sink() -> InMemoryAuditSink:
    """Create an in-memory audit sink for testing."""
    return InMemoryAuditSink()
