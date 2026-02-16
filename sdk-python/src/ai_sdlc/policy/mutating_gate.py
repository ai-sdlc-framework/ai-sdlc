"""Mutating quality gates.

Gates that modify resources before enforcement evaluation.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from ai_sdlc.core.types import AnyResource


@dataclass
class MutatingGateContext:
    author_type: str
    repository: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class MutatingGate(Protocol):
    @property
    def name(self) -> str: ...

    def mutate(self, resource: AnyResource, ctx: MutatingGateContext) -> AnyResource: ...


def create_label_injector(labels: dict[str, str]) -> MutatingGate:
    """Create a mutating gate that injects labels into resource metadata."""

    class _LabelInjector:
        @property
        def name(self) -> str:
            return "label-injector"

        def mutate(self, resource: AnyResource, _ctx: MutatingGateContext) -> AnyResource:
            merged = {**(resource.metadata.labels or {}), **labels}
            new_meta = resource.metadata.model_copy(update={"labels": merged})
            return resource.model_copy(update={"metadata": new_meta})

    return _LabelInjector()


def create_metadata_enricher(annotations: dict[str, str]) -> MutatingGate:
    """Create a mutating gate that enriches metadata with annotations."""

    class _MetadataEnricher:
        @property
        def name(self) -> str:
            return "metadata-enricher"

        def mutate(self, resource: AnyResource, _ctx: MutatingGateContext) -> AnyResource:
            merged = {**(resource.metadata.annotations or {}), **annotations}
            new_meta = resource.metadata.model_copy(update={"annotations": merged})
            return resource.model_copy(update={"metadata": new_meta})

    return _MetadataEnricher()


def create_reviewer_assigner(
    assign_fn: Callable[[AnyResource, MutatingGateContext], list[str]],
) -> MutatingGate:
    """Create a mutating gate that assigns reviewers based on resource content."""

    class _ReviewerAssigner:
        @property
        def name(self) -> str:
            return "reviewer-assigner"

        def mutate(self, resource: AnyResource, ctx: MutatingGateContext) -> AnyResource:
            reviewers = assign_fn(resource, ctx)
            merged = {
                **(resource.metadata.annotations or {}),
                "ai-sdlc.io/reviewers": ",".join(reviewers),
            }
            new_meta = resource.metadata.model_copy(update={"annotations": merged})
            return resource.model_copy(update={"metadata": new_meta})

    return _ReviewerAssigner()


def apply_mutating_gates(
    resource: AnyResource,
    gates: list[MutatingGate],
    ctx: MutatingGateContext,
) -> AnyResource:
    """Apply a chain of mutating gates to a resource.

    Uses deep copy to prevent mutation of the original.
    """
    current = copy.deepcopy(resource)
    for gate in gates:
        current = gate.mutate(current, ctx)
    return current
