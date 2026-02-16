"""Tests for webhook bridge."""

import asyncio

import pytest

from ai_sdlc.adapters.webhook_bridge import create_webhook_bridge


@pytest.mark.asyncio
async def test_push_and_stream() -> None:
    bridge = create_webhook_bridge(lambda p: p.get("event") if isinstance(p, dict) else None)

    events: list[str] = []

    async def consume():
        async for event in bridge.stream():
            events.append(event)
            if len(events) >= 2:
                break

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)
    bridge.push({"event": "created"})
    bridge.push({"event": "updated"})
    await asyncio.wait_for(task, timeout=1.0)
    assert events == ["created", "updated"]


@pytest.mark.asyncio
async def test_transformer_filters_null() -> None:
    bridge = create_webhook_bridge(lambda p: None)
    bridge.push({"anything": True})
    assert bridge.listener_count() == 0


def test_close_bridge() -> None:
    bridge = create_webhook_bridge(lambda p: p)
    bridge.close()
    # Push after close should be ignored
    bridge.push("event")
    assert bridge.listener_count() == 0


def test_listener_count() -> None:
    bridge = create_webhook_bridge(lambda p: p)
    assert bridge.listener_count() == 0
