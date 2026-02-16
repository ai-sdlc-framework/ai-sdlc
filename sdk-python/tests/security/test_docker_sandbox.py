"""Tests for Docker sandbox."""

from __future__ import annotations

import pytest

from ai_sdlc.security.docker_sandbox import DockerSandboxConfig, create_docker_sandbox
from ai_sdlc.security.interfaces import SandboxConstraints


@pytest.mark.asyncio
async def test_docker_sandbox_lifecycle() -> None:
    commands: list[str] = []

    async def mock_exec(cmd: str) -> str:
        commands.append(cmd)
        if cmd.startswith("docker run"):
            return "container-abc123"
        if "inspect" in cmd:
            return "running"
        return ""

    sandbox = create_docker_sandbox(
        mock_exec,
        DockerSandboxConfig(image="python:3.11"),
    )
    constraints = SandboxConstraints(
        max_memory_mb=512, max_cpu_percent=50,
        network_policy="none", timeout_ms=60000,
        allowed_paths=["/workspace"],
    )

    sid = await sandbox.isolate("task-1", constraints)
    assert sid.startswith("docker-task-1-")
    assert any("docker run" in c for c in commands)

    status = await sandbox.get_status(sid)
    assert status == "running"

    await sandbox.destroy(sid)
    assert any("docker rm -f" in c for c in commands)


@pytest.mark.asyncio
async def test_docker_sandbox_not_found() -> None:
    async def noop(cmd: str) -> str:
        return ""

    sandbox = create_docker_sandbox(noop, DockerSandboxConfig(image="node:18"))
    with pytest.raises(KeyError):
        await sandbox.destroy("nonexistent")
