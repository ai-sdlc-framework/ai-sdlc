"""Tests for the AgentRunner protocol and implementations."""

from __future__ import annotations

import asyncio
import subprocess
from unittest.mock import AsyncMock, patch

import pytest


def _can_run_subprocess() -> bool:
    """Check if we can actually execute subprocesses (not just find them on PATH)."""
    try:
        result = subprocess.run(
            ["echo", "test"], capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


HAS_SHELL = _can_run_subprocess()

from ai_sdlc.agents.runner import (
    AgentContext,
    AgentResult,
    AgentRunner,
    NoopRunner,
    SubprocessRunner,
    TokenUsage,
    _extract_files,
)


def _make_context(**overrides) -> AgentContext:
    import tempfile

    defaults = dict(
        issue_number=42,
        issue_title="Test issue",
        issue_body="Fix the thing",
        branch="feature/test",
        repo_path=tempfile.gettempdir(),
        allowed_tools=["read", "write"],
    )
    defaults.update(overrides)
    return AgentContext(**defaults)


class TestAgentContext:
    def test_defaults(self):
        ctx = _make_context()
        assert ctx.issue_number == 42
        assert ctx.system_prompt is None
        assert ctx.extra == {}


class TestTokenUsage:
    def test_defaults(self):
        t = TokenUsage()
        assert t.input_tokens == 0
        assert t.total_tokens == 0

    def test_values(self):
        t = TokenUsage(input_tokens=100, output_tokens=50, total_tokens=150)
        assert t.total_tokens == 150


class TestAgentResult:
    def test_success(self):
        r = AgentResult(output="done")
        assert r.success is True
        assert r.files_changed == []

    def test_failure(self):
        r = AgentResult(output="", exit_code=1, error="boom")
        assert r.success is False

    def test_error_only_marks_failure(self):
        r = AgentResult(output="partial", error="oops")
        assert r.success is False


class TestNoopRunner:
    @pytest.mark.asyncio
    async def test_conforms_to_protocol(self):
        runner = NoopRunner()
        assert isinstance(runner, AgentRunner)
        assert runner.name == "noop"

    @pytest.mark.asyncio
    async def test_run(self):
        runner = NoopRunner()
        result = await runner.run(_make_context())
        assert result.output == "noop"
        assert result.success is True


class TestSubprocessRunner:
    @pytest.mark.asyncio
    async def test_conforms_to_protocol(self):
        runner = SubprocessRunner(["echo", "hello"], runner_name="echo")
        assert isinstance(runner, AgentRunner)
        assert runner.name == "echo"

    @pytest.mark.asyncio
    @pytest.mark.skipif(not HAS_SHELL, reason="No shell available in sandbox")
    async def test_run_captures_stdout(self):
        runner = SubprocessRunner(["echo", "hello world"], runner_name="echo")
        result = await runner.run(_make_context())
        assert "hello world" in result.output
        assert result.success is True

    @pytest.mark.asyncio
    async def test_command_not_found(self):
        runner = SubprocessRunner(["nonexistent_cmd_xyz"])
        result = await runner.run(_make_context())
        assert result.success is False
        assert "not found" in (result.error or "").lower()

    @pytest.mark.asyncio
    @pytest.mark.skipif(not HAS_SHELL, reason="No shell available in sandbox")
    async def test_timeout(self):
        runner = SubprocessRunner(["sleep", "10"], timeout_s=0.1)
        result = await runner.run(_make_context())
        assert result.success is False
        assert "timed out" in (result.error or "").lower()

    @pytest.mark.asyncio
    @pytest.mark.skipif(not HAS_SHELL, reason="No shell available in sandbox")
    async def test_extracts_files(self):
        script = 'echo "[FILE] src/main.ts\n[FILE] src/test.ts"'
        runner = SubprocessRunner(["sh", "-c", script])
        result = await runner.run(_make_context())
        assert "src/main.ts" in result.files_changed
        assert "src/test.ts" in result.files_changed


class TestExtractFiles:
    def test_extracts_file_markers(self):
        output = "some output\n[FILE] a.ts\nmore\n[FILE] b.ts\n"
        assert _extract_files(output) == ["a.ts", "b.ts"]

    def test_no_markers(self):
        assert _extract_files("no files here") == []

    def test_empty(self):
        assert _extract_files("") == []
