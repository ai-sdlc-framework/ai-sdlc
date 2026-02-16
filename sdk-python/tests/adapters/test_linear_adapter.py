"""Tests for Linear adapter stub."""

from __future__ import annotations

import pytest

from ai_sdlc.adapters.interfaces import CreateIssueInput, IssueFilter
from ai_sdlc.adapters.linear import LinearConfig, create_linear_issue_tracker


@pytest.mark.asyncio
async def test_linear_issue_tracker() -> None:
    config = LinearConfig(team_id="team-1")
    tracker = create_linear_issue_tracker(config)
    issue = await tracker.create_issue(CreateIssueInput(title="Task"))
    assert issue.title == "Task"
    issues = await tracker.list_issues(IssueFilter())
    assert isinstance(issues, list)
    got = await tracker.get_issue("stub-1")
    assert got.id == "stub-1"
