"""Distribution builder — parses, validates, and resolves builder-manifest.yaml."""

from __future__ import annotations

from dataclasses import dataclass, field

import yaml


@dataclass
class ManifestAdapter:
    name: str
    version: str


@dataclass
class ManifestOutput:
    name: str
    version: str


@dataclass
class BuilderManifest:
    spec_version: str
    adapters: list[ManifestAdapter]
    output: ManifestOutput


def parse_builder_manifest(yaml_str: str) -> BuilderManifest:
    """Parse a YAML string into a BuilderManifest.

    Raises on invalid YAML or missing top-level structure.
    """
    parsed = yaml.safe_load(yaml_str)
    if not isinstance(parsed, dict):
        raise ValueError("Invalid manifest YAML: expected an object")

    if not parsed.get("spec_version") or not isinstance(parsed["spec_version"], str):
        raise ValueError("Missing or invalid required field: spec_version")
    if not isinstance(parsed.get("adapters"), list):
        raise ValueError("Missing or invalid required field: adapters (must be an array)")
    if not isinstance(parsed.get("output"), dict):
        raise ValueError("Missing or invalid required field: output (must be an object)")

    adapters = [
        ManifestAdapter(name=a.get("name", ""), version=a.get("version", ""))
        for a in parsed["adapters"]
    ]
    output_data = parsed["output"]
    output = ManifestOutput(
        name=output_data.get("name", ""),
        version=output_data.get("version", ""),
    )
    return BuilderManifest(
        spec_version=parsed["spec_version"],
        adapters=adapters,
        output=output,
    )


@dataclass
class ManifestValidationResult:
    valid: bool
    errors: list[str] = field(default_factory=list)


def validate_builder_manifest(manifest: BuilderManifest) -> ManifestValidationResult:
    """Validate a parsed BuilderManifest for correctness."""
    errors: list[str] = []

    if not manifest.spec_version:
        errors.append("spec_version is required")

    if not manifest.adapters:
        errors.append("At least one adapter is required")
    else:
        names: set[str] = set()
        for adapter in manifest.adapters:
            if not adapter.name:
                errors.append("Each adapter must have a name")
            if not adapter.version:
                errors.append(
                    f'Adapter "{adapter.name or "(unnamed)"}" must have a version'
                )
            if adapter.name and adapter.name in names:
                errors.append(f'Duplicate adapter name: "{adapter.name}"')
            if adapter.name:
                names.add(adapter.name)

    if not manifest.output.name:
        errors.append("output.name is required")
    if not manifest.output.version:
        errors.append("output.version is required")

    return ManifestValidationResult(valid=len(errors) == 0, errors=errors)
