"""Schema validation using jsonschema against AI-SDLC JSON Schema definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import jsonschema
import jsonschema.validators
from referencing import Registry, Resource

from ._generated_schemas import SCHEMAS

if TYPE_CHECKING:
    from .types import ResourceKind

SCHEMA_FILES: dict[str, str] = {
    "Pipeline": "pipeline.schema.json",
    "AgentRole": "agent-role.schema.json",
    "QualityGate": "quality-gate.schema.json",
    "AutonomyPolicy": "autonomy-policy.schema.json",
    "AdapterBinding": "adapter-binding.schema.json",
}


@dataclass(frozen=True)
class ValidationError:
    path: str
    message: str
    keyword: str


@dataclass
class ValidationResult:
    valid: bool
    data: dict[str, Any] | None = None
    errors: list[ValidationError] = field(default_factory=list)


def _build_registry() -> Registry[dict[str, Any]]:
    """Build a referencing.Registry with all schemas pre-loaded."""
    resources: list[tuple[str, Resource[dict[str, Any]]]] = []
    for schema in SCHEMAS.values():
        schema_id = schema.get("$id", "")
        resources.append((schema_id, Resource.from_contents(schema)))
    return Registry[dict[str, Any]]().with_resources(resources)


_registry: Registry[dict[str, Any]] | None = None


def _get_registry() -> Registry[dict[str, Any]]:
    global _registry  # noqa: PLW0603
    if _registry is None:
        _registry = _build_registry()
    return _registry


def _get_validator(kind: str) -> jsonschema.Validator:
    schema_file = SCHEMA_FILES.get(kind)
    if not schema_file:
        raise ValueError(f"Unknown resource kind: {kind}")
    schema = SCHEMAS.get(schema_file)
    if not schema:
        raise ValueError(f"Schema not found for: {schema_file}")
    validator_cls = jsonschema.validators.validator_for(schema)
    return validator_cls(schema, registry=_get_registry())  # type: ignore[arg-type]


def validate(kind: ResourceKind, data: Any) -> ValidationResult:
    """Validate a resource document against its JSON Schema."""
    validator = _get_validator(kind)
    errors: list[ValidationError] = []
    for error in validator.iter_errors(data):
        path = "/" + "/".join(str(p) for p in error.absolute_path) if error.absolute_path else "/"
        errors.append(ValidationError(
            path=path,
            message=error.message,
            keyword=str(error.validator),
        ))

    if errors:
        return ValidationResult(valid=False, errors=errors)
    return ValidationResult(valid=True, data=data)


def validate_resource(data: Any) -> ValidationResult:
    """Validate a resource, inferring the kind from the document's ``kind`` field."""
    if not isinstance(data, dict) or "kind" not in data:
        return ValidationResult(
            valid=False,
            errors=[ValidationError(path="/", message='Missing "kind" field', keyword="required")],
        )

    kind = data["kind"]
    if kind not in SCHEMA_FILES:
        return ValidationResult(
            valid=False,
            errors=[
                ValidationError(
                    path="/kind",
                    message=f"Unknown resource kind: {kind}",
                    keyword="enum",
                )
            ],
        )
    return validate(kind, data)
