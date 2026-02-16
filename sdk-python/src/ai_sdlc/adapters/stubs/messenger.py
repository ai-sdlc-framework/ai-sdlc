"""Stub Messenger adapter for testing."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from ai_sdlc.adapters.interfaces import NotificationInput, Thread, ThreadInput


@dataclass(frozen=True)
class NotificationLogEntry:
    channel: str
    message: str
    severity: str | None
    timestamp: str


class StubMessengerAdapter:
    def __init__(self) -> None:
        self._notifications: list[NotificationLogEntry] = []
        self._threads: dict[str, list[str]] = {}
        self._next_id = 1

    async def send_notification(self, input: NotificationInput) -> None:
        self._notifications.append(
            NotificationLogEntry(
                channel=input.channel,
                message=input.message,
                severity=input.severity,
                timestamp=datetime.now(UTC).isoformat(),
            ),
        )

    async def create_thread(self, input: ThreadInput) -> Thread:
        tid = f"thread-{self._next_id}"
        self._next_id += 1
        self._threads[tid] = [input.message]
        return Thread(id=tid, url=f"https://messenger.example.com/threads/{tid}")

    async def post_update(self, thread_id: str, message: str) -> None:
        if thread_id not in self._threads:
            raise KeyError(f'Thread "{thread_id}" not found')
        self._threads[thread_id].append(message)

    def get_notification_log(self) -> list[NotificationLogEntry]:
        return list(self._notifications)


def create_stub_messenger() -> StubMessengerAdapter:
    return StubMessengerAdapter()
