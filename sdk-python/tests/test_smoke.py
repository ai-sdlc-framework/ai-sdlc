"""Smoke test — verifies the package is importable."""

import ai_sdlc


def test_version() -> None:
    assert ai_sdlc.__version__ == "0.1.0"
