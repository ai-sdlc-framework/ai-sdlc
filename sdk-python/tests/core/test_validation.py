"""Tests for JSON Schema validation."""

from pathlib import Path
from typing import get_args

import pytest
import yaml

from ai_sdlc.core.types import ResourceKind
from ai_sdlc.core.validation import SCHEMA_FILES, validate, validate_resource


def _minimal_pipeline() -> dict:
    return {
        "apiVersion": "ai-sdlc.io/v1alpha1",
        "kind": "Pipeline",
        "metadata": {"name": "test"},
        "spec": {
            "triggers": [{"event": "issue.assigned"}],
            "providers": {"gh": {"type": "github"}},
            "stages": [{"name": "implement"}],
        },
    }


def test_validate_valid_pipeline() -> None:
    r = validate("Pipeline", _minimal_pipeline())
    assert r.valid
    assert r.data is not None


def test_validate_pipeline_without_stages_is_valid() -> None:
    # spec.stages is deprecated and no longer required (AISDLC-1280).
    data = _minimal_pipeline()
    del data["spec"]["stages"]
    r = validate("Pipeline", data)
    assert r.valid


def test_validate_invalid_pipeline_missing_triggers() -> None:
    data = _minimal_pipeline()
    del data["spec"]["triggers"]
    r = validate("Pipeline", data)
    assert not r.valid
    assert any("triggers" in e.message for e in r.errors)


def test_validate_resource_infers_kind() -> None:
    r = validate_resource(_minimal_pipeline())
    assert r.valid


def test_validate_resource_missing_kind() -> None:
    r = validate_resource({"apiVersion": "ai-sdlc.io/v1alpha1"})
    assert not r.valid
    assert r.errors[0].message == 'Missing "kind" field'


def test_validate_resource_unknown_kind() -> None:
    r = validate_resource({"kind": "Bogus"})
    assert not r.valid
    assert "Unknown resource kind" in r.errors[0].message


def test_validate_unknown_kind_raises() -> None:
    import pytest

    with pytest.raises(ValueError, match="Unknown resource kind"):
        validate("NotAKind", {})  # type: ignore[arg-type]


# ── The six kinds added in AISDLC-1308 ───────────────────────────────

_FIXTURES = Path(__file__).resolve().parents[3] / "conformance" / "tests" / "v1alpha1"

_NEW_KINDS = {
    "DesignSystemBinding": "design-system-binding",
    "DesignIntentDocument": "design-intent-document",
    "DorConfig": "dor-config",
    "CompliancePosture": "compliance-posture",
    "JudgmentConfig": "judgment-config",
    "CapabilitiesConfig": "capabilities-config",
}


def test_resource_kind_matches_schema_files() -> None:
    assert set(get_args(ResourceKind)) == set(SCHEMA_FILES)
    assert len(SCHEMA_FILES) == 11


@pytest.mark.parametrize("kind,directory", list(_NEW_KINDS.items()))
def test_new_kind_accepts_valid_and_refuses_invalid_fixture(kind: str, directory: str) -> None:
    files = sorted((_FIXTURES / directory).glob("*.yaml"))
    valid = [f for f in files if f.name.startswith("valid-")]
    invalid = [f for f in files if f.name.startswith("invalid-")]
    assert valid and invalid, f"{directory} needs a valid and an invalid fixture"
    for f in valid:
        doc = yaml.safe_load(f.read_text())
        assert doc["kind"] == kind
        r = validate_resource(doc)
        assert r.valid, f"{f.name}: {r.errors}"
    for f in invalid:
        doc = yaml.safe_load(f.read_text())
        assert doc["kind"] == kind
        r = validate_resource(doc)
        assert not r.valid, f"{f.name} was accepted"
        assert all(e.path != "/kind" for e in r.errors), f"{f.name}: kind refused as unknown"
