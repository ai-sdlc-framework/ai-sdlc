"""Tests for duration parsing."""

import pytest

from ai_sdlc._utils.duration import parse_duration


def test_shorthand_seconds() -> None:
    assert parse_duration("60s") == 60_000


def test_shorthand_minutes() -> None:
    assert parse_duration("5m") == 300_000


def test_shorthand_hours() -> None:
    assert parse_duration("2h") == 7_200_000


def test_shorthand_days() -> None:
    assert parse_duration("1d") == 86_400_000


def test_shorthand_weeks() -> None:
    assert parse_duration("2w") == 1_209_600_000


def test_iso_hours_minutes() -> None:
    assert parse_duration("PT1H30M") == 5_400_000


def test_iso_seconds() -> None:
    assert parse_duration("PT30S") == 30_000


def test_iso_hours_only() -> None:
    assert parse_duration("PT2H") == 7_200_000


def test_invalid_duration() -> None:
    with pytest.raises(ValueError, match="Invalid duration"):
        parse_duration("abc")


def test_invalid_iso_zero() -> None:
    with pytest.raises(ValueError, match="Invalid ISO 8601"):
        parse_duration("PT")
