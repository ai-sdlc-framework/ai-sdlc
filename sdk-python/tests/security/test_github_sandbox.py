"""Tests for GitHub Codespaces sandbox."""

from __future__ import annotations

from typing import Any

import pytest

from ai_sdlc.security.github_sandbox import GitHubSandboxConfig, create_github_sandbox
from ai_sdlc.security.interfaces import SandboxConstraints


class MockCodespacesClient:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.stopped: list[str] = []
        self.deleted: list[str] = []
        self._next_id = 1

    async def create_codespace(self, **kwargs: Any) -> dict[str, Any]:
        cid = self._next_id
        self._next_id += 1
        self.created.append(kwargs)
        return {"id": cid, "name": f"cs-name-{cid}", "state": "Available"}

    async def get_codespace(self, name: str) -> dict[str, Any]:
        return {"state": "Available"}

    async def stop_codespace(self, name: str) -> dict[str, Any]:
        self.stopped.append(name)
        return {"state": "ShutDown"}

    async def delete_codespace(self, name: str) -> None:
        self.deleted.append(name)


@pytest.mark.asyncio
async def test_github_sandbox_lifecycle() -> None:
    client = MockCodespacesClient()
    sandbox = create_github_sandbox(
        client,
        GitHubSandboxConfig(owner="acme", repo="app"),
    )
    constraints = SandboxConstraints(
        max_memory_mb=4096, max_cpu_percent=25,
        network_policy="egress-only", timeout_ms=300_000,
        allowed_paths=[],
    )

    sid = await sandbox.isolate("t1", constraints)
    assert sid.startswith("cs-")
    assert len(client.created) == 1

    status = await sandbox.get_status(sid)
    assert status == "running"

    await sandbox.destroy(sid)
    assert len(client.deleted) == 1
