"""Metrics collection types from PRD Section 14.1."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

MetricCategory = Literal[
    "task-effectiveness",
    "human-in-loop",
    "code-quality",
    "economic-efficiency",
    "autonomy-trajectory",
]


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    category: MetricCategory
    description: str
    unit: str


@dataclass(frozen=True)
class MetricDataPoint:
    metric: str
    value: float
    timestamp: str
    labels: dict[str, str] | None = None


@dataclass
class MetricQuery:
    metric: str
    labels: dict[str, str] | None = None
    from_: str | None = None
    to: str | None = None


@dataclass
class MetricSummary:
    metric: str
    count: int
    min: float
    max: float
    avg: float
    latest: float


class MetricStore(Protocol):
    def register(self, definition: MetricDefinition) -> None: ...
    def record(
        self,
        metric: str,
        value: float,
        labels: dict[str, str] | None = None,
        timestamp: str | None = None,
    ) -> MetricDataPoint: ...
    def current(
        self, metric: str, labels: dict[str, str] | None = None,
    ) -> float | None: ...
    def query(self, query: MetricQuery) -> list[MetricDataPoint]: ...
    def summarize(
        self, metric: str, labels: dict[str, str] | None = None,
    ) -> MetricSummary | None: ...
    def snapshot(
        self, labels: dict[str, str] | None = None,
    ) -> dict[str, float]: ...
    def definitions(self) -> list[MetricDefinition]: ...


def _md(
    name: str, cat: MetricCategory, desc: str, unit: str,
) -> MetricDefinition:
    return MetricDefinition(name, cat, desc, unit)


STANDARD_METRICS: list[MetricDefinition] = [
    _md(
        "task-completion-rate", "task-effectiveness",
        "Percentage of tasks completed successfully", "percent",
    ),
    _md(
        "first-pass-success-rate", "task-effectiveness",
        "Percentage of tasks passing on first attempt", "percent",
    ),
    _md(
        "mean-time-to-completion", "task-effectiveness",
        "Average time from task start to completion", "seconds",
    ),
    _md(
        "approval-rate", "human-in-loop",
        "Percentage of AI outputs approved without changes", "percent",
    ),
    _md(
        "revision-count", "human-in-loop",
        "Average number of revisions per task", "count",
    ),
    _md(
        "human-intervention-rate", "human-in-loop",
        "Percentage of tasks requiring human intervention", "percent",
    ),
    _md(
        "test-coverage", "code-quality",
        "Test coverage of generated code", "percent",
    ),
    _md(
        "lint-pass-rate", "code-quality",
        "Percentage of changes passing lint checks", "percent",
    ),
    _md(
        "security-finding-rate", "code-quality",
        "Security findings per 1000 lines of code", "per-kloc",
    ),
    _md(
        "cost-per-task", "economic-efficiency",
        "Average cost per completed task", "usd",
    ),
    _md(
        "time-saved-ratio", "economic-efficiency",
        "Ratio of time saved vs manual execution", "ratio",
    ),
    _md(
        "autonomy-level", "autonomy-trajectory",
        "Current autonomy level of agent", "level",
    ),
    _md(
        "promotion-velocity", "autonomy-trajectory",
        "Rate of autonomy level advancement", "levels-per-month",
    ),
    _md(
        "demotion-frequency", "autonomy-trajectory",
        "Number of demotions per time period", "per-month",
    ),
    _md(
        "handoff-count", "task-effectiveness",
        "Total number of agent-to-agent handoffs", "count",
    ),
    _md(
        "handoff-failure-rate", "task-effectiveness",
        "Percentage of handoffs that failed validation", "percent",
    ),
    _md(
        "approval-wait-time", "human-in-loop",
        "Average time waiting for human approval", "milliseconds",
    ),
    _md(
        "sandbox-violation-count", "code-quality",
        "Number of sandbox constraint violations", "count",
    ),
    _md(
        "kill-switch-activation-count", "autonomy-trajectory",
        "Number of kill switch activations", "count",
    ),
    _md(
        "compliance-coverage", "code-quality",
        "Percentage of applicable compliance controls covered", "percent",
    ),
    _md(
        "adapter-health-rate", "task-effectiveness",
        "Percentage of adapters reporting healthy status", "percent",
    ),
    _md(
        "agent-discovery-count", "task-effectiveness",
        "Number of agents discovered via A2A protocol", "count",
    ),
]
