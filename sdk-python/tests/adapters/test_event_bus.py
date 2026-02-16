"""Tests for InProcessEventBus."""

from __future__ import annotations

import pytest

from ai_sdlc.adapters.event_bus import create_in_process_event_bus


@pytest.mark.asyncio
async def test_publish_subscribe() -> None:
    bus = create_in_process_event_bus()
    received: list[str] = []
    bus.subscribe("test", lambda p: received.append(p))
    await bus.publish("test", "hello")
    assert received == ["hello"]


@pytest.mark.asyncio
async def test_unsubscribe() -> None:
    bus = create_in_process_event_bus()
    received: list[str] = []
    unsub = bus.subscribe("test", lambda p: received.append(p))
    assert bus.subscriber_count("test") == 1
    unsub()
    assert bus.subscriber_count("test") == 0
    await bus.publish("test", "hello")
    assert received == []


@pytest.mark.asyncio
async def test_multiple_topics() -> None:
    bus = create_in_process_event_bus()
    a_msgs: list[str] = []
    b_msgs: list[str] = []
    bus.subscribe("a", lambda p: a_msgs.append(p))
    bus.subscribe("b", lambda p: b_msgs.append(p))
    await bus.publish("a", "x")
    await bus.publish("b", "y")
    assert a_msgs == ["x"]
    assert b_msgs == ["y"]
