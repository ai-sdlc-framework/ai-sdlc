"""Tests for env secret store."""

from __future__ import annotations

import pytest

from ai_sdlc.security.env_secret_store import create_env_secret_store


def test_get_from_env() -> None:
    store = create_env_secret_store({"GITHUB_TOKEN": "abc"})
    assert store.get("github-token") == "abc"


def test_get_missing() -> None:
    store = create_env_secret_store({})
    assert store.get("github-token") is None


def test_get_required_success() -> None:
    store = create_env_secret_store({"API_KEY": "secret"})
    assert store.get_required("api-key") == "secret"


def test_get_required_missing() -> None:
    store = create_env_secret_store({})
    with pytest.raises(ValueError, match="not found"):
        store.get_required("api-key")
