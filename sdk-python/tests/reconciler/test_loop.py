"""Tests for reconciler loop."""

import asyncio

import pytest

from ai_sdlc.core.types import (
    Metadata,
    Pipeline,
    PipelineSpec,
    Provider,
    Stage,
    Trigger,
)
from ai_sdlc.reconciler.loop import (
    ReconcilerLoop,
    calculate_backoff,
    reconcile_once,
)
from ai_sdlc.reconciler.types import (
    ReconcileError,
    ReconcilerConfig,
    ReconcileSuccess,
)


def _pipeline(name: str = "test") -> Pipeline:
    return Pipeline(
        metadata=Metadata(name=name),
        spec=PipelineSpec(
            stages=[Stage(name="build", agent="builder")],
            triggers=[Trigger(event="push")],
            providers={"gh": Provider(type="github")},
        ),
    )


def test_calculate_backoff_increases() -> None:
    config = ReconcilerConfig(initial_backoff_ms=1000, max_backoff_ms=300_000)
    b1 = calculate_backoff(0, config)
    b2 = calculate_backoff(1, config)
    b3 = calculate_backoff(2, config)
    assert b1 >= 1000  # 1000 + up to 10% jitter
    assert b2 >= 2000
    assert b3 >= 4000


def test_calculate_backoff_capped() -> None:
    config = ReconcilerConfig(initial_backoff_ms=1000, max_backoff_ms=5000)
    b = calculate_backoff(100, config)
    assert b <= 5500  # 5000 + 10% jitter


@pytest.mark.asyncio
async def test_reconcile_once_success() -> None:
    async def reconciler(resource: object) -> ReconcileSuccess:
        return ReconcileSuccess()

    result = await reconcile_once(_pipeline(), reconciler)
    assert result.type == "success"


@pytest.mark.asyncio
async def test_reconcile_once_catches_error() -> None:
    async def reconciler(resource: object) -> ReconcileSuccess:
        raise RuntimeError("boom")

    result = await reconcile_once(_pipeline(), reconciler)
    assert result.type == "error"
    assert isinstance(result, ReconcileError)
    assert "boom" in str(result.error)


@pytest.mark.asyncio
async def test_loop_enqueue_and_process() -> None:
    processed: list[str] = []

    async def reconciler(resource: object) -> ReconcileSuccess:
        processed.append(resource.metadata.name)
        return ReconcileSuccess()

    loop = ReconcilerLoop(reconciler, ReconcilerConfig(periodic_interval_ms=999_999))
    loop.enqueue(_pipeline("a"))
    loop.enqueue(_pipeline("b"))

    assert loop.queue_size == 2
    await loop.start()
    # Give time for processing
    await asyncio.sleep(0.05)
    loop.stop()

    assert "a" in processed
    assert "b" in processed


@pytest.mark.asyncio
async def test_loop_deduplicates() -> None:
    count = 0

    async def reconciler(resource: object) -> ReconcileSuccess:
        nonlocal count
        count += 1
        return ReconcileSuccess()

    loop = ReconcilerLoop(reconciler, ReconcilerConfig(periodic_interval_ms=999_999))
    p = _pipeline("dup")
    loop.enqueue(p)
    loop.enqueue(p)  # Should be ignored

    assert loop.queue_size == 1
    await loop.start()
    await asyncio.sleep(0.05)
    loop.stop()

    assert count == 1
