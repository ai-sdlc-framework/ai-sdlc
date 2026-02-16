"""Continuous reconciliation loop.

Implements the controller pattern from spec Section 9.
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ai_sdlc.reconciler.types import (
    DEFAULT_RECONCILER_CONFIG,
    ReconcileError,
    ReconcilerConfig,
    ReconcileRequeueAfter,
    ReconcileResult,
    ReconcilerFn,
)

if TYPE_CHECKING:
    from ai_sdlc.core.types import AnyResource


def calculate_backoff(
    attempt: int,
    config: ReconcilerConfig = DEFAULT_RECONCILER_CONFIG,
) -> float:
    """Calculate exponential backoff with jitter."""
    backoff = min(
        config.initial_backoff_ms * math.pow(2, attempt),
        config.max_backoff_ms,
    )
    jitter = backoff * 0.1 * random.random()
    return math.floor(backoff + jitter)


async def reconcile_once(
    resource: AnyResource,
    reconciler: ReconcilerFn,
) -> ReconcileResult:
    """Run a single reconciliation cycle with error handling."""
    try:
        return await reconciler(resource)
    except Exception as err:
        return ReconcileError(error=err)


@dataclass
class _QueueItem:
    resource: AnyResource
    attempt: int = 0


class ReconcilerLoop:
    """Continuous reconciliation loop with work queue, deduplication, and backoff."""

    def __init__(
        self,
        reconciler: ReconcilerFn,
        config: ReconcilerConfig | None = None,
    ) -> None:
        self._reconciler = reconciler
        self._config = config or ReconcilerConfig()
        self._queue: dict[str, _QueueItem] = {}
        self._active: set[str] = set()
        self._known: dict[str, AnyResource] = {}
        self._running = False
        self._periodic_task: asyncio.Task[None] | None = None

    def enqueue(self, resource: AnyResource) -> None:
        """Enqueue a resource for reconciliation. Deduplicates by name."""
        name = resource.metadata.name
        if name in self._active or name in self._queue:
            return
        self._queue[name] = _QueueItem(resource=resource, attempt=0)
        self._known[name] = resource
        if self._running:
            asyncio.ensure_future(self._process_queue())

    async def start(self) -> None:
        """Start the reconciliation loop and periodic timer."""
        self._running = True
        await self._process_queue()
        self._periodic_task = asyncio.create_task(self._periodic_loop())

    def stop(self) -> None:
        """Stop the reconciliation loop."""
        self._running = False
        if self._periodic_task is not None:
            self._periodic_task.cancel()
            self._periodic_task = None

    @property
    def queue_size(self) -> int:
        return len(self._queue)

    @property
    def active_count(self) -> int:
        return len(self._active)

    async def _periodic_loop(self) -> None:
        try:
            while self._running:
                await asyncio.sleep(self._config.periodic_interval_ms / 1000)
                if not self._running:
                    break
                for name, resource in self._known.items():
                    if name not in self._active and name not in self._queue:
                        self._queue[name] = _QueueItem(resource=resource)
                await self._process_queue()
        except asyncio.CancelledError:
            pass

    async def _process_queue(self) -> None:
        if not self._running:
            return

        available = self._config.max_concurrency - len(self._active)
        if available <= 0:
            return

        entries = list(self._queue.items())[:available]

        tasks = []
        for name, item in entries:
            del self._queue[name]
            self._active.add(name)
            tasks.append(self._process_item(name, item))

        if tasks:
            await asyncio.gather(*tasks)

    async def _process_item(self, name: str, item: _QueueItem) -> None:
        result = await reconcile_once(item.resource, self._reconciler)

        if not self._running:
            self._active.discard(name)
            return

        self._active.discard(name)

        if result.type == "success":
            return

        if result.type == "error":
            next_attempt = item.attempt + 1
            delay = calculate_backoff(next_attempt, self._config)
            await asyncio.sleep(delay / 1000)
            if self._running:
                self._queue[name] = _QueueItem(
                    resource=item.resource, attempt=next_attempt
                )
                await self._process_queue()

        elif result.type == "requeue":
            self._queue[name] = _QueueItem(resource=item.resource, attempt=0)
            await self._process_queue()

        elif result.type == "requeue-after":
            assert isinstance(result, ReconcileRequeueAfter)
            await asyncio.sleep(result.delay_ms / 1000)
            if self._running:
                self._queue[name] = _QueueItem(resource=item.resource, attempt=0)
                await self._process_queue()
