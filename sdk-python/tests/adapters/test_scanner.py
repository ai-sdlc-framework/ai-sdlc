"""Tests for adapter scanner."""

import tempfile
from pathlib import Path

import pytest

from ai_sdlc.adapters.scanner import (
    ScanOptions,
    parse_metadata_yaml,
    scan_local_adapters,
)


def test_parse_metadata_yaml() -> None:
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
    meta = parse_metadata_yaml(yaml_content)
    assert meta.name == "my-adapter"
    assert meta.display_name == "My Adapter"
    assert meta.interfaces == ["IssueTracker@v1"]


def test_parse_invalid_yaml() -> None:
    with pytest.raises(ValueError, match="expected an object"):
        parse_metadata_yaml("just a string")


@pytest.mark.asyncio
async def test_scan_local_adapters() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a valid adapter directory
        adapter_dir = Path(tmpdir) / "my-adapter"
        adapter_dir.mkdir()
        (adapter_dir / "metadata.yaml").write_text(
            """
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
        )

        # Create an invalid adapter directory
        bad_dir = Path(tmpdir) / "bad-adapter"
        bad_dir.mkdir()
        (bad_dir / "metadata.yaml").write_text("invalid: true\n")

        result = await scan_local_adapters(ScanOptions(base_path=tmpdir))
        assert len(result.adapters) == 1
        assert result.adapters[0].name == "my-adapter"
        assert len(result.errors) == 1


@pytest.mark.asyncio
async def test_scan_nonexistent_directory() -> None:
    result = await scan_local_adapters(ScanOptions(base_path="/nonexistent/path"))
    assert len(result.adapters) == 0
    assert len(result.errors) == 1
