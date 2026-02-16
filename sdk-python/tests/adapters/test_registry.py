"""Tests for adapter registry."""

from ai_sdlc.adapters.registry import (
    AdapterMetadata,
    create_adapter_registry,
    validate_adapter_metadata,
)


def _metadata(**kwargs) -> AdapterMetadata:
    defaults = {
        "name": "test-adapter",
        "display_name": "Test Adapter",
        "description": "A test adapter",
        "version": "1.0.0",
        "stability": "stable",
        "interfaces": ["IssueTracker@v1"],
        "owner": "test-org",
        "spec_versions": ["v1alpha1"],
    }
    defaults.update(kwargs)
    return AdapterMetadata(**defaults)


def test_validate_valid_metadata() -> None:
    result = validate_adapter_metadata(_metadata())
    assert result.valid is True
    assert result.errors == []


def test_validate_invalid_name() -> None:
    result = validate_adapter_metadata(_metadata(name="INVALID"))
    assert result.valid is False
    assert any("name" in e.lower() for e in result.errors)


def test_validate_missing_display_name() -> None:
    result = validate_adapter_metadata(_metadata(display_name=""))
    assert result.valid is False


def test_validate_no_interfaces() -> None:
    result = validate_adapter_metadata(_metadata(interfaces=[]))
    assert result.valid is False


def test_validate_bad_interface_format() -> None:
    result = validate_adapter_metadata(_metadata(interfaces=["bad-format"]))
    assert result.valid is False
    assert any("interface" in e.lower() for e in result.errors)


def test_validate_no_spec_versions() -> None:
    result = validate_adapter_metadata(_metadata(spec_versions=[]))
    assert result.valid is False


def test_register_and_resolve() -> None:
    registry = create_adapter_registry()
    meta = _metadata()
    registry.register(meta)
    assert registry.resolve("test-adapter") == meta
    assert registry.resolve("nonexistent") is None


def test_resolve_with_version() -> None:
    registry = create_adapter_registry()
    meta = _metadata()
    registry.register(meta)
    assert registry.resolve("test-adapter", "1.0.0") == meta
    assert registry.resolve("test-adapter", "2.0.0") is None


def test_list_all() -> None:
    registry = create_adapter_registry()
    registry.register(_metadata(name="adapter-a"))
    registry.register(_metadata(name="adapter-b"))
    assert len(registry.list()) == 2


def test_list_with_filter() -> None:
    registry = create_adapter_registry()
    registry.register(_metadata(name="a", interfaces=["IssueTracker@v1"]))
    registry.register(_metadata(name="b", interfaces=["SourceControl@v1"]))
    filtered = registry.list("IssueTracker")
    assert len(filtered) == 1
    assert filtered[0].name == "a"


def test_has() -> None:
    registry = create_adapter_registry()
    registry.register(_metadata())
    assert registry.has("test-adapter") is True
    assert registry.has("nonexistent") is False


def test_get_factory() -> None:
    registry = create_adapter_registry()
    def factory():
        return "instance"
    registry.register(_metadata(), factory)
    assert registry.get_factory("test-adapter") is factory
    assert registry.get_factory("nonexistent") is None
