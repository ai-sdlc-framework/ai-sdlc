"""Reconciliation loop types from spec Section 9."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ReconcileSuccess:
    type: str = "success"


@dataclass(frozen=True)
class ReconcileError:
    type: str = "error"
    error: Exception = field(default_factory=lambda: Exception("Unknown error"))
    retry_after_ms: int | None = None


@dataclass(frozen=True)
class ReconcileRequeue:
    type: str = "requeue"


@dataclass(frozen=True)
class ReconcileRequeueAfter:
    type: str = "requeue-after"
    delay_ms: int = 0


ReconcileResult = ReconcileSuccess | ReconcileError | ReconcileRequeue | ReconcileRequeueAfter

ReconcilerFn = Callable[[Any], Awaitable[ReconcileResult]]


@dataclass
class ReconcilerConfig:
    """Configuration for the reconciliation engine."""

    periodic_interval_ms: int = 30_000
    max_backoff_ms: int = 300_000
    initial_backoff_ms: int = 1_000
    max_concurrency: int = 10


DEFAULT_RECONCILER_CONFIG = ReconcilerConfig()
