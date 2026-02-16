"""Tests for complexity scoring and routing."""

from ai_sdlc.policy.complexity import (
    ComplexityInput,
    evaluate_complexity,
    route_by_complexity,
    score_complexity,
)


def test_low_complexity() -> None:
    result = score_complexity(ComplexityInput(files_affected=2, lines_of_change=30))
    assert 1 <= result <= 3


def test_high_complexity() -> None:
    result = score_complexity(
        ComplexityInput(
            files_affected=50,
            lines_of_change=2000,
            security_sensitive=True,
            database_migration=True,
        )
    )
    assert result >= 7


def test_route_low() -> None:
    assert route_by_complexity(1) == "fully-autonomous"
    assert route_by_complexity(3) == "fully-autonomous"


def test_route_medium() -> None:
    assert route_by_complexity(4) == "ai-with-review"
    assert route_by_complexity(6) == "ai-with-review"


def test_route_high() -> None:
    assert route_by_complexity(7) == "ai-assisted"
    assert route_by_complexity(8) == "ai-assisted"


def test_route_critical() -> None:
    assert route_by_complexity(9) == "human-led"
    assert route_by_complexity(10) == "human-led"


def test_evaluate_complexity_combined() -> None:
    result = evaluate_complexity(ComplexityInput(files_affected=3, lines_of_change=50))
    assert 1 <= result.score <= 10
    assert result.strategy in ("fully-autonomous", "ai-with-review", "ai-assisted", "human-led")
    assert "fileScope" in result.factors
    assert "changeSize" in result.factors


def test_security_sensitive_raises_score() -> None:
    base = evaluate_complexity(ComplexityInput(files_affected=3, lines_of_change=50))
    sensitive = evaluate_complexity(
        ComplexityInput(files_affected=3, lines_of_change=50, security_sensitive=True)
    )
    assert sensitive.score >= base.score
