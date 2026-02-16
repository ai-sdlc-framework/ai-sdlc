"""Tests for distribution manifest parsing and validation."""

import pytest

from ai_sdlc.builders.distribution import (
    BuilderManifest,
    ManifestAdapter,
    ManifestOutput,
    parse_builder_manifest,
    validate_builder_manifest,
)

_VALID_YAML = """\
spec_version: "1.0"
adapters:
  - name: github
    version: "1.0.0"
  - name: linear
    version: "0.5.0"
output:
  name: my-distribution
  version: "1.0.0"
"""


def test_parse_valid_manifest() -> None:
    m = parse_builder_manifest(_VALID_YAML)
    assert m.spec_version == "1.0"
    assert len(m.adapters) == 2
    assert m.adapters[0].name == "github"
    assert m.output.name == "my-distribution"


def test_parse_invalid_yaml() -> None:
    with pytest.raises(ValueError, match="expected an object"):
        parse_builder_manifest("just a string")


def test_parse_missing_spec_version() -> None:
    with pytest.raises(ValueError, match="spec_version"):
        parse_builder_manifest("adapters: []\noutput: {}")


def test_parse_missing_adapters() -> None:
    with pytest.raises(ValueError, match="adapters"):
        parse_builder_manifest('spec_version: "1.0"\noutput: {}')


def test_parse_missing_output() -> None:
    with pytest.raises(ValueError, match="output"):
        parse_builder_manifest('spec_version: "1.0"\nadapters: []')


def test_validate_valid() -> None:
    m = parse_builder_manifest(_VALID_YAML)
    result = validate_builder_manifest(m)
    assert result.valid
    assert result.errors == []


def test_validate_empty_adapters() -> None:
    m = BuilderManifest(
        spec_version="1.0",
        adapters=[],
        output=ManifestOutput(name="x", version="1.0"),
    )
    result = validate_builder_manifest(m)
    assert not result.valid
    assert any("At least one adapter" in e for e in result.errors)


def test_validate_adapter_missing_name() -> None:
    m = BuilderManifest(
        spec_version="1.0",
        adapters=[ManifestAdapter(name="", version="1.0")],
        output=ManifestOutput(name="x", version="1.0"),
    )
    result = validate_builder_manifest(m)
    assert not result.valid


def test_validate_duplicate_adapters() -> None:
    m = BuilderManifest(
        spec_version="1.0",
        adapters=[
            ManifestAdapter(name="gh", version="1.0"),
            ManifestAdapter(name="gh", version="2.0"),
        ],
        output=ManifestOutput(name="x", version="1.0"),
    )
    result = validate_builder_manifest(m)
    assert not result.valid
    assert any("Duplicate" in e for e in result.errors)


def test_validate_missing_output_name() -> None:
    m = BuilderManifest(
        spec_version="1.0",
        adapters=[ManifestAdapter(name="gh", version="1.0")],
        output=ManifestOutput(name="", version="1.0"),
    )
    result = validate_builder_manifest(m)
    assert not result.valid
