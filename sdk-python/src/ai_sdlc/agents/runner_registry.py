"""Runner registry with discovery.

Manages registered AgentRunner instances and supports auto-discovery
from environment variables.
"""

from __future__ import annotations

import os

from ai_sdlc.agents.runner import AgentRunner, NoopRunner, SubprocessRunner


class RunnerRegistry:
    """Registry for agent runners.

    Allows registration, lookup, and auto-discovery of runners.
    """

    def __init__(self) -> None:
        self._runners: dict[str, AgentRunner] = {}
        self._default: str | None = None

    def register(self, name: str, runner: AgentRunner, *, default: bool = False) -> None:
        """Register a runner. First registered becomes default if none set."""
        self._runners[name] = runner
        if default or self._default is None:
            self._default = name

    def get(self, name: str) -> AgentRunner | None:
        """Retrieve a runner by name."""
        return self._runners.get(name)

    def get_default(self) -> AgentRunner | None:
        """Get the default runner."""
        if self._default is None:
            return None
        return self._runners.get(self._default)

    def set_default(self, name: str) -> None:
        """Set the default runner by name."""
        if name not in self._runners:
            raise KeyError(f"Runner '{name}' not registered")
        self._default = name

    def list_runners(self) -> list[str]:
        """List all registered runner names."""
        return list(self._runners.keys())

    def has(self, name: str) -> bool:
        """Check if a runner is registered."""
        return name in self._runners

    def discover_from_env(self) -> list[str]:
        """Auto-discover runners from environment variables.

        Checks:
        - CLAUDE_CODE_PATH → SubprocessRunner for Claude Code
        - AI_SDLC_RUNNER_CMD → SubprocessRunner with custom command
        Returns list of discovered runner names.
        """
        discovered: list[str] = []

        claude_path = os.environ.get("CLAUDE_CODE_PATH")
        if claude_path:
            self.register(
                "claude-code",
                SubprocessRunner(
                    [claude_path, "--print"],
                    runner_name="claude-code",
                ),
            )
            discovered.append("claude-code")

        custom_cmd = os.environ.get("AI_SDLC_RUNNER_CMD")
        if custom_cmd:
            self.register(
                "custom",
                SubprocessRunner(
                    custom_cmd.split(),
                    runner_name="custom",
                ),
            )
            discovered.append("custom")

        return discovered


def create_runner_registry() -> RunnerRegistry:
    """Factory that creates a registry and runs auto-discovery."""
    registry = RunnerRegistry()
    registry.register("noop", NoopRunner())
    registry.discover_from_env()
    return registry
