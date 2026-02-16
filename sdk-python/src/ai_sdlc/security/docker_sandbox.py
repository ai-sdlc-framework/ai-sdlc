"""Docker container sandbox provider."""

from __future__ import annotations

import math
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .interfaces import SandboxConstraints, SandboxStatus

ShellExec = Callable[[str], Coroutine[object, object, str]]


@dataclass
class DockerSandboxConfig:
    image: str
    network: str | None = None


class _DockerSandbox:
    def __init__(self, exec_fn: ShellExec, config: DockerSandboxConfig) -> None:
        self._exec = exec_fn
        self._config = config
        self._containers: dict[str, str] = {}

    async def isolate(
        self, task_id: str, constraints: SandboxConstraints,
    ) -> str:
        import time

        sandbox_id = f"docker-{task_id}-{int(time.time() * 1000)}"
        network = (
            "none" if constraints.network_policy == "none"
            else (self._config.network or "bridge")
        )
        mem = f"--memory={constraints.max_memory_mb}m"
        cpu = f"--cpus={constraints.max_cpu_percent / 100:.2f}"
        net = f"--network={network}"
        timeout_s = math.ceil(constraints.timeout_ms / 1000)

        cmd = (
            f"docker run -d {mem} {cpu} {net} "
            f"--name {sandbox_id} {self._config.image} "
            f"sleep {timeout_s}"
        )
        container_id = (await self._exec(cmd)).strip()
        self._containers[sandbox_id] = container_id
        return sandbox_id

    async def destroy(self, sandbox_id: str) -> None:
        container_id = self._containers.get(sandbox_id)
        if not container_id:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        await self._exec(f"docker rm -f {container_id}")
        del self._containers[sandbox_id]

    async def get_status(self, sandbox_id: str) -> SandboxStatus:
        container_id = self._containers.get(sandbox_id)
        if not container_id:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        state = (
            await self._exec(
                f"docker inspect -f '{{{{.State.Status}}}}' {container_id}",
            )
        ).strip()
        state_map: dict[str, SandboxStatus] = {
            "running": "running",
            "created": "idle",
            "exited": "terminated",
            "dead": "terminated",
            "removing": "terminated",
        }
        return state_map.get(state, "error")


def create_docker_sandbox(
    exec_fn: ShellExec, config: DockerSandboxConfig,
) -> _DockerSandbox:
    """Create a Docker-backed sandbox provider."""
    return _DockerSandbox(exec_fn, config)
