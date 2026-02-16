"""JSONL file-based audit sink."""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .logger import compute_entry_hash
from .types import AuditEntry, IntegrityResult


def _entry_to_dict(entry: AuditEntry) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": entry.id,
        "timestamp": entry.timestamp,
        "actor": entry.actor,
        "action": entry.action,
        "resource": entry.resource,
        "decision": entry.decision,
    }
    if entry.policy is not None:
        d["policy"] = entry.policy
    if entry.details is not None:
        d["details"] = entry.details
    if entry.hash is not None:
        d["hash"] = entry.hash
    if entry.previous_hash is not None:
        d["previousHash"] = entry.previous_hash
    return d


def _dict_to_entry(d: dict[str, Any]) -> AuditEntry:
    return AuditEntry(
        id=d["id"],
        timestamp=d["timestamp"],
        actor=d["actor"],
        action=d["action"],
        resource=d["resource"],
        decision=d["decision"],
        policy=d.get("policy"),
        details=d.get("details"),
        hash=d.get("hash"),
        previous_hash=d.get("previousHash"),
    )


class _FileSink:
    def __init__(self, file_path: str) -> None:
        self._path = Path(file_path)

    def write(self, entry: AuditEntry) -> None:
        line = json.dumps(_entry_to_dict(entry)) + "\n"
        with self._path.open("a") as f:
            f.write(line)


def create_file_sink(file_path: str) -> _FileSink:
    """Create an append-only JSONL file sink."""
    return _FileSink(file_path)


def load_entries_from_file(file_path: str) -> list[AuditEntry]:
    """Load audit entries from a JSONL file."""
    p = Path(file_path)
    if not p.exists():
        return []
    content = p.read_text().strip()
    if not content:
        return []
    return [_dict_to_entry(json.loads(line)) for line in content.split("\n") if line]


def verify_file_integrity(file_path: str) -> IntegrityResult:
    """Verify the integrity of a JSONL audit file."""
    entries = load_entries_from_file(file_path)
    if not entries:
        return IntegrityResult(valid=True)

    for i, entry in enumerate(entries):
        expected_prev = entries[i - 1].hash if i > 0 else None
        if entry.previous_hash != expected_prev:
            return IntegrityResult(valid=False, broken_at=i)
        recomputed = compute_entry_hash(entry, expected_prev)
        if entry.hash != recomputed:
            return IntegrityResult(valid=False, broken_at=i)

    return IntegrityResult(valid=True)


def rotate_audit_file(file_path: str) -> str:
    """Rotate an audit log file by copying it with a timestamp suffix."""
    p = Path(file_path)
    ts = datetime.now(UTC).isoformat().replace(":", "-").replace(".", "-")
    rotated = f"{file_path}.{ts}"
    if p.exists():
        shutil.copy2(str(p), rotated)
        p.write_text("")
    return rotated
