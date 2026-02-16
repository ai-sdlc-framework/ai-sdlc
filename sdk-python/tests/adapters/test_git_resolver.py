"""Tests for git adapter resolver."""

import pytest

from ai_sdlc.adapters.git_resolver import (
    build_raw_url,
    create_stub_git_adapter_fetcher,
    parse_git_adapter_ref,
    resolve_git_adapter,
)


def test_parse_git_ref() -> None:
    ref = parse_git_adapter_ref("github.com/my-org/my-adapter@v1.0.0")
    assert ref.host == "github.com"
    assert ref.org == "my-org"
    assert ref.repo == "my-adapter"
    assert ref.ref == "v1.0.0"


def test_parse_git_ref_invalid() -> None:
    with pytest.raises(ValueError, match="Invalid git adapter reference"):
        parse_git_adapter_ref("invalid")


def test_build_raw_url_github() -> None:
    ref = parse_git_adapter_ref("github.com/my-org/my-adapter@v1.0.0")
    url = build_raw_url(ref)
    assert url == "https://raw.githubusercontent.com/my-org/my-adapter/v1.0.0/metadata.yaml"


def test_build_raw_url_unsupported() -> None:
    ref = parse_git_adapter_ref("gitlab.com/my-org/my-adapter@v1.0.0")
    with pytest.raises(ValueError, match="Unsupported git host"):
        build_raw_url(ref)


@pytest.mark.asyncio
async def test_resolve_git_adapter_success() -> None:
    yaml_content = """
name: my-adapter
displayName: My Adapter
description: A great adapter
version: "1.0.0"
stability: stable
interfaces:
  - IssueTracker@v1
owner: my-org
specVersions:
  - v1alpha1
"""
    url = "https://raw.githubusercontent.com/my-org/my-adapter/v1.0.0/metadata.yaml"
    fetcher = create_stub_git_adapter_fetcher({url: yaml_content})
    result = await resolve_git_adapter("github.com/my-org/my-adapter@v1.0.0", fetcher)
    assert result.metadata is not None
    assert result.metadata.name == "my-adapter"
    assert result.error is None


@pytest.mark.asyncio
async def test_resolve_git_adapter_not_found() -> None:
    fetcher = create_stub_git_adapter_fetcher({})
    result = await resolve_git_adapter("github.com/my-org/my-adapter@v1.0.0", fetcher)
    assert result.metadata is None
    assert "Failed to fetch" in (result.error or "")


@pytest.mark.asyncio
async def test_resolve_git_adapter_invalid_ref() -> None:
    fetcher = create_stub_git_adapter_fetcher({})
    result = await resolve_git_adapter("invalid", fetcher)
    assert result.metadata is None
    assert "Invalid git adapter reference" in (result.error or "")


@pytest.mark.asyncio
async def test_resolve_git_adapter_invalid_yaml() -> None:
    url = "https://raw.githubusercontent.com/my-org/my-adapter/v1.0.0/metadata.yaml"
    fetcher = create_stub_git_adapter_fetcher({url: "just a string"})
    result = await resolve_git_adapter("github.com/my-org/my-adapter@v1.0.0", fetcher)
    assert result.metadata is None
    assert "Invalid YAML" in (result.error or "") or "Validation failed" in (result.error or "")
