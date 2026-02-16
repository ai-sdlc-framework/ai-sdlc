"""Stub DeploymentTarget adapter for testing."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

from ai_sdlc.adapters.interfaces import (
    DeployEvent,
    DeployFilter,
    DeployInput,
    Deployment,
    DeploymentStatus,
)


class StubDeploymentTargetAdapter:
    def __init__(self) -> None:
        self._deployments: dict[str, Deployment] = {}
        self._next_id = 1

    async def deploy(self, input: DeployInput) -> Deployment:
        did = f"deploy-{self._next_id}"
        self._next_id += 1
        dep = Deployment(
            id=did,
            status="in-progress",
            environment=input.environment,
            url=f"https://deploy.example.com/{did}",
        )
        self._deployments[did] = dep
        return dep

    async def get_deployment_status(self, id: str) -> DeploymentStatus:
        dep = self._deployments.get(id)
        if not dep:
            raise KeyError(f'Deployment "{id}" not found')
        return DeploymentStatus(
            id=dep.id,
            status="succeeded",
            environment=dep.environment,
            timestamp=datetime.now(UTC).isoformat(),
        )

    async def rollback(self, id: str) -> Deployment:
        dep = self._deployments.get(id)
        if not dep:
            raise KeyError(f'Deployment "{id}" not found')
        rolled = Deployment(
            id=dep.id,
            status="rolled-back",
            environment=dep.environment,
            url=dep.url,
        )
        self._deployments[id] = rolled
        return rolled

    def watch_deployment_events(
        self, filter: DeployFilter,
    ) -> AsyncIterator[DeployEvent]:
        async def _empty() -> AsyncIterator[DeployEvent]:
            return
            yield  # noqa: RET504  # pragma: no cover

        return _empty()

    def get_deployment_count(self) -> int:
        return len(self._deployments)


def create_stub_deployment_target() -> StubDeploymentTargetAdapter:
    return StubDeploymentTargetAdapter()
