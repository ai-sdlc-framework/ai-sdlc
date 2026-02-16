"""Append-only audit log with tamper-evident hash chain."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime
from typing import Any

from .types import AuditEntry, AuditFilter, AuditSink, Decision, IntegrityResult

_counter = 0


def _generate_id() -> str:
    global _counter  # noqa: PLW0603
    _counter += 1
    return f"audit-{int(time.time() * 1000)}-{_counter}"


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


def compute_entry_hash(
    entry: AuditEntry,
    previous_hash: str | None = None,
) -> str:
    """Compute a SHA-256 hash for an audit entry, chaining to the previous hash."""
    payload = json.dumps(
        {
            "id": entry.id,
            "timestamp": entry.timestamp,
            "actor": entry.actor,
            "action": entry.action,
            "resource": entry.resource,
            "policy": entry.policy,
            "decision": entry.decision,
            "details": entry.details,
            "previousHash": previous_hash,
        },
        sort_keys=False,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


class _AuditLogImpl:
    def __init__(self, sink: AuditSink | None = None) -> None:
        self._log: list[AuditEntry] = []
        self._sink = sink

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
    ) -> AuditEntry:
        prev_hash = self._log[-1].hash if self._log else None

        base = AuditEntry(
            id=_generate_id(),
            timestamp=timestamp or datetime.now(UTC).isoformat(),
            actor=actor,
            action=action,
            resource=resource,
            policy=policy,
            decision=decision,
            details=details,
            previous_hash=prev_hash,
        )

        hash_val = compute_entry_hash(base, prev_hash)
        entry = AuditEntry(
            id=base.id,
            timestamp=base.timestamp,
            actor=base.actor,
            action=base.action,
            resource=base.resource,
            policy=base.policy,
            decision=base.decision,
            details=base.details,
            hash=hash_val,
            previous_hash=prev_hash,
        )

        self._log.append(entry)
        if self._sink:
            self._sink.write(entry)
        return entry

    def entries(self) -> list[AuditEntry]:
        return list(self._log)

    def query(self, filter: AuditFilter) -> list[AuditEntry]:
        return [e for e in self._log if _matches_filter(e, filter)]

    def verify_integrity(self) -> IntegrityResult:
        if not self._log:
            return IntegrityResult(valid=True)

        for i, entry in enumerate(self._log):
            expected_prev = self._log[i - 1].hash if i > 0 else None
            if entry.previous_hash != expected_prev:
                return IntegrityResult(valid=False, broken_at=i)

            recomputed = compute_entry_hash(entry, expected_prev)
            if entry.hash != recomputed:
                return IntegrityResult(valid=False, broken_at=i)

        return IntegrityResult(valid=True)


def create_audit_log(sink: AuditSink | None = None) -> _AuditLogImpl:
    """Create an append-only audit log with optional external sink."""
    return _AuditLogImpl(sink)
