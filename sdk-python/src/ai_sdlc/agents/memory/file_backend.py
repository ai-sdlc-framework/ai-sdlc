"""JSON file-based persistent memory backend.

Stores long-term and episodic memory tiers to disk.
Working and short-term memory remain in-memory by design.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_sdlc.agents.memory.types import MemoryEntry


def _ensure_dir(file_path: str) -> None:
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)


def _load_store(file_path: str) -> dict[str, Any]:
    p = Path(file_path)
    if not p.exists():
        return {"entries": {}}
    result: dict[str, Any] = json.loads(p.read_text(encoding="utf-8"))
    return result


def _save_store(file_path: str, store: dict[str, Any]) -> None:
    _ensure_dir(file_path)
    Path(file_path).write_text(
        json.dumps(store, indent=2), encoding="utf-8"
    )


def _entry_from_dict(d: dict[str, Any]) -> MemoryEntry:
    return MemoryEntry(
        id=d["id"],
        tier=d["tier"],
        key=d["key"],
        value=d["value"],
        created_at=d["created_at"],
        expires_at=d.get("expires_at"),
        metadata=d.get("metadata"),
    )


def _entry_to_dict(e: MemoryEntry) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": e.id,
        "tier": e.tier,
        "key": e.key,
        "value": e.value,
        "created_at": e.created_at,
    }
    if e.expires_at is not None:
        d["expires_at"] = e.expires_at
    if e.metadata is not None:
        d["metadata"] = e.metadata
    return d


class _FileLongTermMemory:
    def __init__(self, file_path: str) -> None:
        self._path = file_path
        self._store = _load_store(file_path)

    def get(self, key: str) -> Any | None:
        entry = self._store["entries"].get(key)
        return entry["value"] if entry else None

    def set(
        self, key: str, value: Any, metadata: dict[str, str] | None = None
    ) -> None:
        entry = MemoryEntry(
            id=str(uuid.uuid4()),
            tier="long-term",
            key=key,
            value=value,
            created_at=datetime.now(UTC).isoformat(),
            metadata=metadata,
        )
        self._store["entries"][key] = _entry_to_dict(entry)
        _save_store(self._path, self._store)

    def delete(self, key: str) -> bool:
        if key not in self._store["entries"]:
            return False
        del self._store["entries"][key]
        _save_store(self._path, self._store)
        return True

    def search(self, prefix: str) -> list[MemoryEntry]:
        self._store = _load_store(self._path)
        return [
            _entry_from_dict(v)
            for k, v in self._store["entries"].items()
            if k.startswith(prefix)
        ]

    def keys(self) -> list[str]:
        self._store = _load_store(self._path)
        return list(self._store["entries"].keys())


def create_file_long_term_memory(file_path: str) -> _FileLongTermMemory:
    """Create a file-backed long-term memory store."""
    return _FileLongTermMemory(file_path)


def _load_episodic_store(file_path: str) -> dict[str, Any]:
    p = Path(file_path)
    if not p.exists():
        return {"entries": []}
    result: dict[str, Any] = json.loads(p.read_text(encoding="utf-8"))
    return result


def _save_episodic_store(file_path: str, store: dict[str, Any]) -> None:
    _ensure_dir(file_path)
    Path(file_path).write_text(
        json.dumps(store, indent=2), encoding="utf-8"
    )


class _FileEpisodicMemory:
    def __init__(self, file_path: str) -> None:
        self._path = file_path
        self._store = _load_episodic_store(file_path)

    def append(self, event: dict[str, Any]) -> MemoryEntry:
        entry = MemoryEntry(
            id=str(uuid.uuid4()),
            tier="episodic",
            key=event["key"],
            value=event["value"],
            created_at=datetime.now(UTC).isoformat(),
            metadata=event.get("metadata"),
        )
        self._store["entries"].append(_entry_to_dict(entry))
        _save_episodic_store(self._path, self._store)
        return entry

    def recent(self, limit: int) -> list[MemoryEntry]:
        self._store = _load_episodic_store(self._path)
        return [_entry_from_dict(d) for d in self._store["entries"][-limit:]]

    def search(self, key: str) -> list[MemoryEntry]:
        self._store = _load_episodic_store(self._path)
        return [
            _entry_from_dict(d)
            for d in self._store["entries"]
            if d["key"] == key
        ]


def create_file_episodic_memory(file_path: str) -> _FileEpisodicMemory:
    """Create a file-backed episodic memory store."""
    return _FileEpisodicMemory(file_path)
