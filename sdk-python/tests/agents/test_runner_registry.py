"""Tests for the RunnerRegistry."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from ai_sdlc.agents.runner import AgentRunner, NoopRunner
from ai_sdlc.agents.runner_registry import RunnerRegistry, create_runner_registry


class TestRunnerRegistry:
    def test_register_and_get(self):
        reg = RunnerRegistry()
        runner = NoopRunner()
        reg.register("noop", runner)
        assert reg.get("noop") is runner

    def test_unknown_returns_none(self):
        reg = RunnerRegistry()
        assert reg.get("nonexistent") is None

    def test_first_registered_is_default(self):
        reg = RunnerRegistry()
        runner = NoopRunner()
        reg.register("first", runner)
        assert reg.get_default() is runner

    def test_explicit_default(self):
        reg = RunnerRegistry()
        r1 = NoopRunner()
        r2 = NoopRunner()
        reg.register("a", r1)
        reg.register("b", r2, default=True)
        assert reg.get_default() is r2

    def test_set_default(self):
        reg = RunnerRegistry()
        r1 = NoopRunner()
        r2 = NoopRunner()
        reg.register("a", r1)
        reg.register("b", r2)
        reg.set_default("b")
        assert reg.get_default() is r2

    def test_set_default_unknown_raises(self):
        reg = RunnerRegistry()
        with pytest.raises(KeyError):
            reg.set_default("missing")

    def test_list_runners(self):
        reg = RunnerRegistry()
        reg.register("a", NoopRunner())
        reg.register("b", NoopRunner())
        assert sorted(reg.list_runners()) == ["a", "b"]

    def test_has(self):
        reg = RunnerRegistry()
        reg.register("present", NoopRunner())
        assert reg.has("present") is True
        assert reg.has("absent") is False

    def test_discover_claude_code(self):
        reg = RunnerRegistry()
        with patch.dict(os.environ, {"CLAUDE_CODE_PATH": "/usr/local/bin/claude"}):
            discovered = reg.discover_from_env()
        assert "claude-code" in discovered
        assert reg.has("claude-code")

    def test_discover_custom_cmd(self):
        reg = RunnerRegistry()
        with patch.dict(os.environ, {"AI_SDLC_RUNNER_CMD": "python agent.py"}):
            discovered = reg.discover_from_env()
        assert "custom" in discovered
        assert reg.has("custom")

    def test_empty_env_no_discovery(self):
        reg = RunnerRegistry()
        with patch.dict(os.environ, {}, clear=True):
            discovered = reg.discover_from_env()
        assert discovered == []


class TestCreateRunnerRegistry:
    def test_factory_includes_noop(self):
        with patch.dict(os.environ, {}, clear=True):
            reg = create_runner_registry()
        assert reg.has("noop")
        assert reg.get_default() is not None
