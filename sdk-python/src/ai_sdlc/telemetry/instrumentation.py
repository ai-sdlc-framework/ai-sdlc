"""OpenTelemetry instrumentation helpers for AI-SDLC."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from opentelemetry import metrics, trace
from opentelemetry.trace import StatusCode

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

TRACER_NAME = "ai-sdlc-framework"
METER_NAME = "ai-sdlc-framework"


def get_tracer() -> trace.Tracer:
    """Get the AI-SDLC tracer instance."""
    return trace.get_tracer(TRACER_NAME)


def get_meter() -> metrics.Meter:
    """Get the AI-SDLC meter instance."""
    return metrics.get_meter(METER_NAME)


@asynccontextmanager
async def with_span(
    name: str,
    attributes: dict[str, str | int | float | bool] | None = None,
) -> AsyncGenerator[trace.Span, None]:
    """Execute within an OpenTelemetry span (async context manager)."""
    tracer = get_tracer()
    with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
        try:
            yield span
            span.set_status(StatusCode.OK)
        except Exception as exc:
            span.set_status(StatusCode.ERROR, str(exc))
            span.record_exception(exc)
            raise


def with_span_sync(
    name: str,
    attributes: dict[str, Any] | None = None,
) -> Any:
    """Create a synchronous span context manager."""
    tracer = get_tracer()
    return tracer.start_as_current_span(name, attributes=attributes or {})
