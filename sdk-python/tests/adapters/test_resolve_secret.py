"""Tests for resolve_secret."""

from __future__ import annotations

import os

import pytest

from ai_sdlc.adapters.resolve_secret import resolve_secret


def test_resolve_secret_kebab_to_upper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "gh-secret")
    assert resolve_secret("github-token") == "gh-secret"


def test_resolve_secret_missing() -> None:
    # Ensure the env var doesn't exist
    os.environ.pop("NONEXISTENT_SECRET", None)
    with pytest.raises(ValueError, match="not found"):
        resolve_secret("nonexistent-secret")
