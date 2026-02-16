"""GitHub Codespaces sandbox provider."""

from __future__ import annotations

import contextlib
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from .interfaces import SandboxConstraints, SandboxStatus


class CodespacesClient(Protocol):
    """Minimal protocol for GitHub Codespaces API."""

    async def create_codespace(self, **kwargs: Any) -> dict[str, Any]: ...
    async def get_codespace(self, name: str) -> dict[str, Any]: ...
    async def stop_codespace(self, name: str) -> dict[str, Any]: ...
    async def delete_codespace(self, name: str) -> None: ...


@dataclass
class GitHubSandboxConfig:
    owner: str
    repo: str
    ref: str | None = None
    devcontainer_path: str | None = None
    default_machine: str | None = None


def _map_codespace_state(state: str) -> SandboxStatus:
    if state in ("Available", "Starting", "Rebuilding"):
        return "running"
    if state in ("ShuttingDown", "ShutDown", "Deleted"):
        return "terminated"
    if state == "Failed":
        return "error"
    return "idle"


def _select_machine(
    constraints: SandboxConstraints, default: str | None,
) -> str:
    if default:
        return default
    if constraints.max_cpu_percent <= 25 and constraints.max_memory_mb <= 4096:
        return "basicLinux32gb"
    if constraints.max_cpu_percent <= 50 and constraints.max_memory_mb <= 8192:
        return "standardLinux32gb"
    return "premiumLinux"


class _GitHubSandbox:
    def __init__(
        self, client: CodespacesClient, config: GitHubSandboxConfig,
    ) -> None:
        self._client = client
        self._config = config
        self._sandbox_map: dict[str, str] = {}

    async def isolate(
        self, task_id: str, constraints: SandboxConstraints,
    ) -> str:
        idle_timeout = max(5, min(240, math.ceil(
            constraints.timeout_ms / 60_000,
        )))
        machine = _select_machine(constraints, self._config.default_machine)

        resp = await self._client.create_codespace(
            owner=self._config.owner,
            repo=self._config.repo,
            ref=self._config.ref,
            machine=machine,
            devcontainer_path=self._config.devcontainer_path,
            idle_timeout_minutes=idle_timeout,
            display_name=f"sandbox-{task_id}",
        )
        sandbox_id = f"cs-{resp['id']}"
        self._sandbox_map[sandbox_id] = resp["name"]
        return sandbox_id

    async def destroy(self, sandbox_id: str) -> None:
        name = self._sandbox_map.get(sandbox_id)
        if not name:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        with contextlib.suppress(Exception):
            await self._client.stop_codespace(name)
        await self._client.delete_codespace(name)
        del self._sandbox_map[sandbox_id]

    async def get_status(self, sandbox_id: str) -> SandboxStatus:
        name = self._sandbox_map.get(sandbox_id)
        if not name:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        resp = await self._client.get_codespace(name)
        return _map_codespace_state(resp.get("state", ""))


def create_github_sandbox(
    client: CodespacesClient, config: GitHubSandboxConfig,
) -> _GitHubSandbox:
    """Create a GitHub Codespaces-backed sandbox."""
    return _GitHubSandbox(client, config)
