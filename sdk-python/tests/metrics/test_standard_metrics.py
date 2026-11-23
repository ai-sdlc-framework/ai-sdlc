"""Standard metric names must match reference/src/metrics/types.ts."""

from ai_sdlc.metrics.types import STANDARD_METRICS

EXPECTED = {
    "task-completion-rate",
    "first-pass-success-rate",
    "mean-time-to-completion",
    "approval-rate",
    "revision-count",
    "human-intervention-rate",
    "test-coverage",
    "lint-pass-rate",
    "security-finding-rate",
    "cost-per-task",
    "time-saved-ratio",
    "autonomy-level",
    "promotion-velocity",
    "demotion-frequency",
    "handoff-count",
    "handoff-failure-rate",
    "approval-wait-time",
    "sandbox-violation-count",
    "kill-switch-activation-count",
    "compliance-coverage",
    "adapter-health-rate",
    "agent-discovery-count",
    "total-cost-usd",
    "total-input-tokens",
    "total-output-tokens",
    "cost-per-run",
    "tokens-per-run",
}


def test_standard_metric_names_match_reference() -> None:
    names = [m.name for m in STANDARD_METRICS]
    assert len(names) == 27
    assert set(names) == EXPECTED
