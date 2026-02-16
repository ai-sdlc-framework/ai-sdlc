"""Agent runner protocol and implementations.

Defines the AgentRunner protocol (PEP 544) matching the TypeScript AgentRunner
interface, plus a SubprocessRunner for executing external CLI agents.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass
class AgentContext:
    """Context passed to an agent runner."""

    issue_number: int
    issue_title: str
    issue_body: str
    branch: str
    repo_path: str
    allowed_tools: list[str] = field(default_factory=list)
    system_prompt: str | None = None
    max_tokens: int | None = None
    timeout_ms: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class TokenUsage:
    """Token usage from a runner invocation."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


@dataclass
class AgentResult:
    """Result from an agent runner invocation."""

    output: str
    files_changed: list[str] = field(default_factory=list)
    tokens: TokenUsage = field(default_factory=TokenUsage)
    exit_code: int = 0
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def success(self) -> bool:
        return self.exit_code == 0 and self.error is None


@runtime_checkable
class AgentRunner(Protocol):
    """Protocol for agent runners.

    Matches the TypeScript AgentRunner interface from the reference
    implementation. Runners implement this to enable different AI backends.
    """

    async def run(self, context: AgentContext) -> AgentResult:
        """Execute the agent with the given context."""
        ...

    @property
    def name(self) -> str:
        """Human-readable name for this runner."""
        ...


class SubprocessRunner:
    """Runs an external CLI tool as an agent via subprocess.

    Captures stdout as the agent output and parses file paths from
    structured markers in the output.
    """

    def __init__(
        self,
        command: list[str],
        *,
        runner_name: str = "subprocess",
        timeout_s: float = 300,
        env: dict[str, str] | None = None,
    ) -> None:
        self._command = command
        self._name = runner_name
        self._timeout_s = timeout_s
        self._env = env

    @property
    def name(self) -> str:
        return self._name

    async def run(self, context: AgentContext) -> AgentResult:
        """Spawn subprocess and collect results."""
        import os

        env = {**os.environ, **(self._env or {})}
        env["AI_SDLC_ISSUE_NUMBER"] = str(context.issue_number)
        env["AI_SDLC_ISSUE_TITLE"] = context.issue_title
        env["AI_SDLC_BRANCH"] = context.branch
        env["AI_SDLC_REPO_PATH"] = context.repo_path

        timeout = context.timeout_ms / 1000 if context.timeout_ms else self._timeout_s

        try:
            proc = await asyncio.create_subprocess_exec(
                *self._command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=context.repo_path,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            return AgentResult(
                output="",
                exit_code=1,
                error=f"Subprocess timed out after {timeout}s",
            )
        except FileNotFoundError:
            return AgentResult(
                output="",
                exit_code=1,
                error=f"Command not found: {self._command[0]}",
            )

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        exit_code = proc.returncode or 0

        files_changed = _extract_files(stdout)

        return AgentResult(
            output=stdout,
            files_changed=files_changed,
            exit_code=exit_code,
            error=stderr if exit_code != 0 else None,
        )


class NoopRunner:
    """A runner that does nothing. Useful for testing."""

    @property
    def name(self) -> str:
        return "noop"

    async def run(self, context: AgentContext) -> AgentResult:
        return AgentResult(output="noop", files_changed=[])


def _extract_files(output: str) -> list[str]:
    """Extract file paths from structured markers in output.

    Looks for lines like: [FILE] path/to/file.ts
    """
    pattern = re.compile(r"^\[FILE\]\s+(.+)$", re.MULTILINE)
    return pattern.findall(output)
