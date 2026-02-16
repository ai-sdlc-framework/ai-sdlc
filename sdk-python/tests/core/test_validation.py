"""Tests for JSON Schema validation."""

from ai_sdlc.core.validation import validate, validate_resource


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


def test_validate_invalid_pipeline_missing_stages() -> None:
    data = _minimal_pipeline()
    del data["spec"]["stages"]
    r = validate("Pipeline", data)
    assert not r.valid
    assert any("stages" in e.message for e in r.errors)


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
