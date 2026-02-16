"""Audit logging types from PRD Section 15.4."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

Decision = Literal["allowed", "denied", "overridden"]


@dataclass(frozen=True)
class AuditEntry:
    id: str
    timestamp: str
    actor: str
    action: str
    resource: str
    decision: Decision
    policy: str | None = None
    details: dict[str, Any] | None = None
    hash: str | None = None
    previous_hash: str | None = None


@dataclass
class AuditFilter:
    actor: str | None = None
    action: str | None = None
    resource: str | None = None
    decision: Decision | None = None
    from_: str | None = None
    to: str | None = None


@dataclass(frozen=True)
class IntegrityResult:
    valid: bool
    broken_at: int | None = None


class AuditSink(Protocol):
    def write(self, entry: AuditEntry) -> None: ...


class AuditLog(Protocol):
    def record(
        self,
        *,
        actor: str,
        action: str,
        resource: str,
        decision: Decision,
        policy: str | None = None,
        details: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> AuditEntry: ...

    def entries(self) -> list[AuditEntry]: ...
    def query(self, filter: AuditFilter) -> list[AuditEntry]: ...
    def verify_integrity(self) -> IntegrityResult: ...
