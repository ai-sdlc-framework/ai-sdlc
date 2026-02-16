"""Local filesystem adapter scanner.

Reads adapter metadata.yaml files from a directory structure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from ai_sdlc.adapters.registry import AdapterMetadata, validate_adapter_metadata


@dataclass
class ScanOptions:
    base_path: str
    skip_invalid: bool = True


@dataclass
class ScanError:
    path: str
    error: str


@dataclass
class ScanResult:
    adapters: list[AdapterMetadata] = field(default_factory=list)
    errors: list[ScanError] = field(default_factory=list)


def parse_metadata_yaml(content: str) -> AdapterMetadata:
    """Parse a metadata YAML string into AdapterMetadata."""
    parsed = yaml.safe_load(content)
    if not parsed or not isinstance(parsed, dict):
        raise ValueError("Invalid YAML: expected an object")
    return AdapterMetadata(
        name=parsed.get("name", ""),
        display_name=parsed.get("displayName", ""),
        description=parsed.get("description", ""),
        version=parsed.get("version", ""),
        stability=parsed.get("stability", "alpha"),
        interfaces=parsed.get("interfaces", []),
        owner=parsed.get("owner", ""),
        spec_versions=parsed.get("specVersions", []),
        repository=parsed.get("repository"),
        dependencies=parsed.get("dependencies"),
    )


async def scan_local_adapters(options: ScanOptions) -> ScanResult:
    """Scan a directory for adapter metadata.yaml files.

    Expects structure: ``<base_path>/<adapter-name>/metadata.yaml``
    """
    base = Path(options.base_path)
    adapters: list[AdapterMetadata] = []
    errors: list[ScanError] = []

    if not base.is_dir():
        return ScanResult(
            errors=[ScanError(path=str(base), error=f"Cannot read directory: {base}")]
        )

    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        metadata_path = entry / "metadata.yaml"
        try:
            content = metadata_path.read_text(encoding="utf-8")
            metadata = parse_metadata_yaml(content)
            validation = validate_adapter_metadata(metadata)
            if validation.valid:
                adapters.append(metadata)
            else:
                errors.append(
                    ScanError(path=str(metadata_path), error="; ".join(validation.errors))
                )
        except Exception as err:
            errors.append(ScanError(path=str(metadata_path), error=str(err)))

    return ScanResult(adapters=adapters, errors=errors)
