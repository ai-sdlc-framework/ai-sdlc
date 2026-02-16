"""In-memory metric store with per-label tracking."""

from __future__ import annotations

from datetime import UTC, datetime

from .types import MetricDataPoint, MetricDefinition, MetricQuery, MetricSummary


def _labels_match(
    point_labels: dict[str, str] | None,
    query_labels: dict[str, str] | None,
) -> bool:
    if not query_labels:
        return True
    if not point_labels:
        return False
    return all(point_labels.get(k) == v for k, v in query_labels.items())


class _MetricStoreImpl:
    def __init__(self) -> None:
        self._definitions: dict[str, MetricDefinition] = {}
        self._data: dict[str, list[MetricDataPoint]] = {}

    def register(self, definition: MetricDefinition) -> None:
        self._definitions[definition.name] = definition

    def record(
        self,
        metric: str,
        value: float,
        labels: dict[str, str] | None = None,
        timestamp: str | None = None,
    ) -> MetricDataPoint:
        point = MetricDataPoint(
            metric=metric,
            value=value,
            timestamp=timestamp or datetime.now(UTC).isoformat(),
            labels=labels,
        )
        self._data.setdefault(metric, []).append(point)
        return point

    def current(self, metric: str, labels: dict[str, str] | None = None) -> float | None:
        points = self._data.get(metric)
        if not points:
            return None
        for p in reversed(points):
            if _labels_match(p.labels, labels):
                return p.value
        return None

    def query(self, query: MetricQuery) -> list[MetricDataPoint]:
        points = self._data.get(query.metric)
        if not points:
            return []
        result: list[MetricDataPoint] = []
        for p in points:
            if not _labels_match(p.labels, query.labels):
                continue
            if query.from_ and p.timestamp < query.from_:
                continue
            if query.to and p.timestamp > query.to:
                continue
            result.append(p)
        return result

    def summarize(
        self, metric: str, labels: dict[str, str] | None = None
    ) -> MetricSummary | None:
        points = self._data.get(metric)
        if not points:
            return None
        matching = [p for p in points if _labels_match(p.labels, labels)]
        if not matching:
            return None
        values = [p.value for p in matching]
        return MetricSummary(
            metric=metric,
            count=len(values),
            min=min(values),
            max=max(values),
            avg=sum(values) / len(values),
            latest=values[-1],
        )

    def snapshot(self, labels: dict[str, str] | None = None) -> dict[str, float]:
        result: dict[str, float] = {}
        for metric, points in self._data.items():
            for p in reversed(points):
                if _labels_match(p.labels, labels):
                    result[metric] = p.value
                    break
        return result

    def definitions(self) -> list[MetricDefinition]:
        return list(self._definitions.values())


def create_metric_store() -> _MetricStoreImpl:
    """Create an in-memory metric store."""
    return _MetricStoreImpl()
