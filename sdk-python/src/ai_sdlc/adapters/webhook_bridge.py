"""Webhook-to-EventStream bridge.

Converts incoming webhook payloads into typed async event streams.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any, Generic, TypeVar

T = TypeVar("T")

WebhookTransformer = Callable[[Any], T | None]


class WebhookBridge(Generic[T]):
    """A webhook bridge converts raw webhook payloads into typed events."""

    def __init__(self, transformer: WebhookTransformer[T]) -> None:
        self._transformer = transformer
        self._queues: list[asyncio.Queue[T | None]] = []
        self._closed = False

    def push(self, payload: Any) -> None:
        """Push a raw webhook payload into the bridge for processing."""
        if self._closed:
            return
        event = self._transformer(payload)
        if event is not None:
            for q in self._queues:
                q.put_nowait(event)

    async def stream(self) -> AsyncIterator[T]:
        """Create an async iterator that yields typed events."""
        queue: asyncio.Queue[T | None] = asyncio.Queue()
        self._queues.append(queue)
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            if queue in self._queues:
                self._queues.remove(queue)

    def listener_count(self) -> int:
        """Number of active listeners."""
        return len(self._queues)

    def close(self) -> None:
        """Close the bridge, ending all active streams."""
        self._closed = True
        for q in self._queues:
            q.put_nowait(None)
        self._queues.clear()


def create_webhook_bridge(transformer: WebhookTransformer[T]) -> WebhookBridge[T]:
    """Create a webhook bridge that transforms raw payloads into typed events."""
    return WebhookBridge(transformer)
