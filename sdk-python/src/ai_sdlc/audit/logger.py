"""Append-only audit log with tamper-evident hash chain."""

from __future__ import annotations

import hashlib
import json
import math
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from .types import AuditEntry, AuditFilter, AuditSink, Decision, IntegrityResult

AUDIT_SCHEMA_VERSION = "2"

_counter = 0


def _format_number(value: int | float) -> str:
    """Format a number in the ECMAScript shortest form required by RFC 8785."""
    f = float(value)
    if not math.isfinite(f):
        raise ValueError("Cannot canonicalize a non-finite number")
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    _, digit_tuple, exp = Decimal(repr(abs(f))).as_tuple()
    digits = "".join(str(d) for d in digit_tuple).rstrip("0") or "0"
    # position of the decimal point relative to the digit string
    n = len("".join(str(d) for d in digit_tuple)) + int(exp)
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        esign = "+" if e >= 0 else "-"
        mant = digits if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mant}e{esign}{abs(e)}"
    return sign + body


def canonicalize(value: Any) -> str:
    """Serialize a value per RFC 8785 (JSON Canonicalization Scheme)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _format_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return (
            "{"
            + ",".join(
                f"{json.dumps(k, ensure_ascii=False)}:{canonicalize(value[k])}" for k in keys
            )
            + "}"
        )
    raise TypeError(f"Cannot canonicalize a value of type {type(value).__name__}")


def _format_timestamp(dt: datetime) -> str:
    """RFC 3339 UTC with millisecond precision, e.g. 2026-01-02T03:04:05.006Z."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


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
    """Compute a SHA-256 hash for an audit entry, chaining to the previous hash.

    Entries with ``schema_version == "2"`` hash the RFC 8785 canonical form; entries
    without a schema version use the legacy rule so old chains still verify.
    """
    if entry.schema_version == AUDIT_SCHEMA_VERSION:
        canonical: dict[str, Any] = {
            "schemaVersion": AUDIT_SCHEMA_VERSION,
            "id": entry.id,
            "timestamp": entry.timestamp,
            "actor": entry.actor,
            "action": entry.action,
            "resource": entry.resource,
            "decision": entry.decision,
        }
        if entry.policy is not None:
            canonical["policy"] = entry.policy
        if entry.details is not None:
            canonical["details"] = entry.details
        if previous_hash is not None:
            canonical["previousHash"] = previous_hash
        return hashlib.sha256(canonicalize(canonical).encode("utf-8")).hexdigest()
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
            timestamp=timestamp or _format_timestamp(datetime.now(UTC)),
            actor=actor,
            action=action,
            resource=resource,
            policy=policy,
            decision=decision,
            details=details,
            previous_hash=prev_hash,
            schema_version=AUDIT_SCHEMA_VERSION,
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
            schema_version=AUDIT_SCHEMA_VERSION,
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
