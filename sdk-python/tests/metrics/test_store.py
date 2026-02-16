"""Tests for metric store."""

from ai_sdlc.metrics.store import create_metric_store
from ai_sdlc.metrics.types import MetricDefinition, MetricQuery


def test_register_and_record() -> None:
    store = create_metric_store()
    store.register(MetricDefinition("coverage", "code-quality", "test", "percent"))
    pt = store.record("coverage", 85.0)
    assert pt.value == 85.0
    assert store.current("coverage") == 85.0


def test_query() -> None:
    store = create_metric_store()
    store.record("x", 1.0, timestamp="2024-01-01T00:00:00Z")
    store.record("x", 2.0, timestamp="2024-01-02T00:00:00Z")
    store.record("x", 3.0, timestamp="2024-01-03T00:00:00Z")

    results = store.query(MetricQuery(
        metric="x", from_="2024-01-02T00:00:00Z", to="2024-01-02T23:59:59Z"
    ))
    assert len(results) == 1
    assert results[0].value == 2.0


def test_summarize() -> None:
    store = create_metric_store()
    store.record("m", 10.0)
    store.record("m", 20.0)
    store.record("m", 30.0)

    s = store.summarize("m")
    assert s is not None
    assert s.count == 3
    assert s.min == 10.0
    assert s.max == 30.0
    assert s.avg == 20.0
    assert s.latest == 30.0


def test_labels() -> None:
    store = create_metric_store()
    store.record("m", 1.0, labels={"agent": "a"})
    store.record("m", 2.0, labels={"agent": "b"})

    assert store.current("m", {"agent": "a"}) == 1.0
    assert store.current("m", {"agent": "b"}) == 2.0


def test_snapshot() -> None:
    store = create_metric_store()
    store.record("x", 1.0)
    store.record("y", 2.0)
    snap = store.snapshot()
    assert snap == {"x": 1.0, "y": 2.0}


def test_definitions() -> None:
    store = create_metric_store()
    defn = MetricDefinition("m", "code-quality", "desc", "pct")
    store.register(defn)
    assert store.definitions() == [defn]


def test_current_missing() -> None:
    store = create_metric_store()
    assert store.current("nonexistent") is None


def test_summarize_missing() -> None:
    store = create_metric_store()
    assert store.summarize("nonexistent") is None
