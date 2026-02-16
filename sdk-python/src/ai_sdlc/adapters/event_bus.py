"""In-process EventBus implementation backed by a simple dict of handlers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable


class InProcessEventBus:
    """In-process pub/sub event bus."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[Callable[..., Any]]] = {}

    async def publish(self, topic: str, payload: Any) -> None:
        for handler in self._handlers.get(topic, []):
            handler(payload)

    def subscribe(
        self, topic: str, handler: Callable[..., Any],
    ) -> Callable[[], None]:
        self._handlers.setdefault(topic, []).append(handler)

        def unsubscribe() -> None:
            handlers = self._handlers.get(topic, [])
            if handler in handlers:
                handlers.remove(handler)

        return unsubscribe

    def subscriber_count(self, topic: str) -> int:
        return len(self._handlers.get(topic, []))


def create_in_process_event_bus() -> InProcessEventBus:
    """Create an in-process event bus."""
    return InProcessEventBus()
