"""In-memory implementation of the 5-tier agent memory model."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_sdlc.agents.memory.types import (
    AgentMemory,
    MemoryEntry,
)


class _WorkingMemory:
    def __init__(self) -> None:
        self._store: dict[str, Any] = {}

    def get(self, key: str) -> Any | None:
        return self._store.get(key)

    def set(self, key: str, value: Any) -> None:
        self._store[key] = value

    def delete(self, key: str) -> bool:
        if key in self._store:
            del self._store[key]
            return True
        return False

    def clear(self) -> None:
        self._store.clear()

    def keys(self) -> list[str]:
        return list(self._store.keys())


@dataclass
class _TTLEntry:
    value: Any
    expires_at: float  # time.time() based


class _ShortTermMemory:
    def __init__(self) -> None:
        self._store: dict[str, _TTLEntry] = {}

    def _is_expired(self, entry: _TTLEntry) -> bool:
        return time.time() * 1000 > entry.expires_at

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if self._is_expired(entry):
            del self._store[key]
            return None
        return entry.value

    def set(self, key: str, value: Any, ttl_ms: int) -> None:
        self._store[key] = _TTLEntry(
            value=value, expires_at=time.time() * 1000 + ttl_ms
        )

    def delete(self, key: str) -> bool:
        if key in self._store:
            del self._store[key]
            return True
        return False

    def keys(self) -> list[str]:
        # Clean up expired entries
        expired = [k for k, v in self._store.items() if self._is_expired(v)]
        for k in expired:
            del self._store[k]
        return list(self._store.keys())


class _LongTermMemory:
    def __init__(self) -> None:
        self._store: dict[str, MemoryEntry] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        return entry.value if entry else None

    def set(
        self, key: str, value: Any, metadata: dict[str, str] | None = None
    ) -> None:
        self._store[key] = MemoryEntry(
            id=str(uuid.uuid4()),
            tier="long-term",
            key=key,
            value=value,
            created_at=datetime.now(UTC).isoformat(),
            metadata=metadata,
        )

    def delete(self, key: str) -> bool:
        if key in self._store:
            del self._store[key]
            return True
        return False

    def search(self, prefix: str) -> list[MemoryEntry]:
        return [e for k, e in self._store.items() if k.startswith(prefix)]

    def keys(self) -> list[str]:
        return list(self._store.keys())


class _SharedMemory:
    def __init__(self) -> None:
        self._store: dict[str, dict[str, Any]] = {}

    def _ns(self, namespace: str) -> dict[str, Any]:
        if namespace not in self._store:
            self._store[namespace] = {}
        return self._store[namespace]

    def get(self, namespace: str, key: str) -> Any | None:
        return self._ns(namespace).get(key)

    def set(self, namespace: str, key: str, value: Any) -> None:
        self._ns(namespace)[key] = value

    def delete(self, namespace: str, key: str) -> bool:
        ns = self._ns(namespace)
        if key in ns:
            del ns[key]
            return True
        return False

    def keys(self, namespace: str) -> list[str]:
        return list(self._ns(namespace).keys())


class _EpisodicMemory:
    def __init__(self) -> None:
        self._entries: list[MemoryEntry] = []

    def append(self, event: dict[str, Any]) -> MemoryEntry:
        entry = MemoryEntry(
            id=str(uuid.uuid4()),
            tier="episodic",
            key=event["key"],
            value=event["value"],
            created_at=datetime.now(UTC).isoformat(),
            metadata=event.get("metadata"),
        )
        self._entries.append(entry)
        return entry

    def recent(self, limit: int) -> list[MemoryEntry]:
        return self._entries[-limit:]

    def search(self, key: str) -> list[MemoryEntry]:
        return [e for e in self._entries if e.key == key]


def create_agent_memory() -> AgentMemory:
    """Create a complete in-memory agent memory with all 5 tiers."""
    return AgentMemory(
        working=_WorkingMemory(),
        short_term=_ShortTermMemory(),
        long_term=_LongTermMemory(),
        shared=_SharedMemory(),
        episodic=_EpisodicMemory(),
    )
