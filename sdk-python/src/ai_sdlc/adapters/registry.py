"""Adapter discovery and registration.

Implements a registry for adapter metadata and factory resolution.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

AdapterStability = str  # 'stable' | 'beta' | 'alpha' | 'deprecated'
AdapterFactory = Callable[[], Any]

_ADAPTER_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")
_INTERFACE_PATTERN = re.compile(r"^[A-Z][A-Za-z]+@v\d+$")


@dataclass
class AdapterMetadata:
    name: str
    display_name: str
    description: str
    version: str
    stability: AdapterStability
    interfaces: list[str]
    owner: str
    spec_versions: list[str]
    repository: str | None = None
    dependencies: list[str] | None = None


@dataclass(frozen=True)
class MetadataValidationResult:
    valid: bool
    errors: list[str] = field(default_factory=list)


def validate_adapter_metadata(metadata: AdapterMetadata) -> MetadataValidationResult:
    """Validate adapter metadata."""
    errors: list[str] = []

    if not metadata.name or not _ADAPTER_NAME_PATTERN.match(metadata.name):
        errors.append(
            f'Invalid adapter name "{metadata.name}": must match pattern ^[a-z][a-z0-9-]*$'
        )

    if not metadata.display_name:
        errors.append("Missing required field: displayName")

    if not metadata.version:
        errors.append("Missing required field: version")

    if not metadata.owner:
        errors.append("Missing required field: owner")

    if not metadata.interfaces or len(metadata.interfaces) == 0:
        errors.append("At least one interface is required")
    else:
        for iface in metadata.interfaces:
            if not _INTERFACE_PATTERN.match(iface):
                errors.append(
                    f'Invalid interface format "{iface}": must match <Name>@v<N>'
                )

    if not metadata.spec_versions or len(metadata.spec_versions) == 0:
        errors.append("At least one specVersion is required")

    return MetadataValidationResult(valid=len(errors) == 0, errors=errors)


class AdapterRegistry(Protocol):
    def register(
        self, metadata: AdapterMetadata, factory: AdapterFactory | None = None,
    ) -> None: ...
    def resolve(self, name: str, version: str | None = None) -> AdapterMetadata | None: ...
    def list(self, interface_filter: str | None = None) -> list[AdapterMetadata]: ...
    def has(self, name: str) -> bool: ...
    def get_factory(self, name: str) -> AdapterFactory | None: ...


class _InMemoryRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, tuple[AdapterMetadata, AdapterFactory | None]] = {}

    def register(self, metadata: AdapterMetadata, factory: AdapterFactory | None = None) -> None:
        self._adapters[metadata.name] = (metadata, factory)

    def resolve(self, name: str, version: str | None = None) -> AdapterMetadata | None:
        entry = self._adapters.get(name)
        if entry is None:
            return None
        meta, _ = entry
        if version and meta.version != version:
            return None
        return meta

    def list(self, interface_filter: str | None = None) -> list[AdapterMetadata]:
        all_meta = [m for m, _ in self._adapters.values()]
        if not interface_filter:
            return all_meta
        return [m for m in all_meta if any(i.startswith(interface_filter) for i in m.interfaces)]

    def has(self, name: str) -> bool:
        return name in self._adapters

    def get_factory(self, name: str) -> AdapterFactory | None:
        entry = self._adapters.get(name)
        return entry[1] if entry else None


def create_adapter_registry() -> AdapterRegistry:
    """Create an in-memory adapter registry."""
    return _InMemoryRegistry()
