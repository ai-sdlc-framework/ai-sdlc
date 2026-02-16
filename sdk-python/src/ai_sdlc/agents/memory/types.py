"""Agent memory types from PRD Section 13.3.

Five-tier memory model:
1. Working — ephemeral, current task context
2. Short-term — TTL-based, recent interactions
3. Long-term — persistent, learned patterns
4. Shared — cross-agent shared state
5. Episodic — append-only, event history
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

MemoryTier = Literal["working", "short-term", "long-term", "shared", "episodic"]


@dataclass
class MemoryEntry:
    id: str
    tier: MemoryTier
    key: str
    value: Any
    created_at: str
    expires_at: str | None = None
    metadata: dict[str, str] | None = None


class WorkingMemory(Protocol):
    def get(self, key: str) -> Any | None: ...
    def set(self, key: str, value: Any) -> None: ...
    def delete(self, key: str) -> bool: ...
    def clear(self) -> None: ...
    def keys(self) -> list[str]: ...


class ShortTermMemory(Protocol):
    def get(self, key: str) -> Any | None: ...
    def set(self, key: str, value: Any, ttl_ms: int) -> None: ...
    def delete(self, key: str) -> bool: ...
    def keys(self) -> list[str]: ...


class LongTermMemory(Protocol):
    def get(self, key: str) -> Any | None: ...
    def set(
        self, key: str, value: Any, metadata: dict[str, str] | None = None
    ) -> None: ...
    def delete(self, key: str) -> bool: ...
    def search(self, prefix: str) -> list[MemoryEntry]: ...
    def keys(self) -> list[str]: ...


class SharedMemory(Protocol):
    def get(self, namespace: str, key: str) -> Any | None: ...
    def set(self, namespace: str, key: str, value: Any) -> None: ...
    def delete(self, namespace: str, key: str) -> bool: ...
    def keys(self, namespace: str) -> list[str]: ...


class EpisodicMemory(Protocol):
    def append(
        self,
        event: dict[str, Any],
    ) -> MemoryEntry: ...
    def recent(self, limit: int) -> list[MemoryEntry]: ...
    def search(self, key: str) -> list[MemoryEntry]: ...


@dataclass
class AgentMemory:
    working: WorkingMemory
    short_term: ShortTermMemory
    long_term: LongTermMemory
    shared: SharedMemory
    episodic: EpisodicMemory


class MemoryStore(Protocol):
    """Persistence backend for agent memory tiers."""

    async def read(self, key: str) -> Any | None: ...
    async def write(self, key: str, value: Any) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def list(self, prefix: str | None = None) -> list[str]: ...
