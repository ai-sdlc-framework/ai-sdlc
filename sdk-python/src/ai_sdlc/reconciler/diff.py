"""Resource diff utilities for reconciler optimization.

Allows skipping reconciliation when only .status has changed (PRD Section 12).
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ai_sdlc.core.types import AnyResource


def resource_fingerprint(resource: AnyResource) -> str:
    """Compute a SHA-256 fingerprint of a resource's spec and metadata.

    Ignores .status entirely. Used for O(1) change detection.
    """
    payload = json.dumps(
        {
            "spec": resource.spec.model_dump(by_alias=True),
            "metadata": {
                "name": resource.metadata.name,
                "labels": resource.metadata.labels,
                "annotations": resource.metadata.annotations,
            },
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def has_spec_changed(previous: AnyResource, current: AnyResource) -> bool:
    """Check whether a resource's spec or metadata has changed.

    Status-only changes return False.
    """
    return resource_fingerprint(previous) != resource_fingerprint(current)


class ResourceCache(Protocol):
    def should_reconcile(self, resource: AnyResource) -> bool: ...
    def clear(self) -> None: ...
    def size(self) -> int: ...


def create_resource_cache() -> ResourceCache:
    """Create a fingerprint cache for efficient change detection."""

    class _Cache:
        def __init__(self) -> None:
            self._cache: dict[str, str] = {}

        def should_reconcile(self, resource: AnyResource) -> bool:
            name = resource.metadata.name
            fp = resource_fingerprint(resource)
            cached = self._cache.get(name)
            if cached == fp:
                return False
            self._cache[name] = fp
            return True

        def clear(self) -> None:
            self._cache.clear()

        def size(self) -> int:
            return len(self._cache)

    return _Cache()
