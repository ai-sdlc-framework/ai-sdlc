"""Tests for reconciler types."""

from ai_sdlc.reconciler.types import (
    DEFAULT_RECONCILER_CONFIG,
    ReconcileError,
    ReconcileRequeue,
    ReconcileRequeueAfter,
    ReconcileSuccess,
)


def test_reconcile_success() -> None:
    r = ReconcileSuccess()
    assert r.type == "success"


def test_reconcile_error() -> None:
    r = ReconcileError(error=ValueError("bad"))
    assert r.type == "error"
    assert isinstance(r.error, ValueError)


def test_reconcile_requeue() -> None:
    r = ReconcileRequeue()
    assert r.type == "requeue"


def test_reconcile_requeue_after() -> None:
    r = ReconcileRequeueAfter(delay_ms=5000)
    assert r.type == "requeue-after"
    assert r.delay_ms == 5000


def test_default_config() -> None:
    cfg = DEFAULT_RECONCILER_CONFIG
    assert cfg.periodic_interval_ms == 30_000
    assert cfg.max_backoff_ms == 300_000
    assert cfg.initial_backoff_ms == 1_000
    assert cfg.max_concurrency == 10
