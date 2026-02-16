"""Tests for GitHub adapter stubs."""

from __future__ import annotations

import pytest

from ai_sdlc.adapters.github import (
    GitHubConfig,
    create_github_ci_pipeline,
    create_github_issue_tracker,
    create_github_source_control,
)
from ai_sdlc.adapters.interfaces import (
    CreateBranchInput,
    CreateIssueInput,
    IssueFilter,
    TriggerBuildInput,
)


@pytest.mark.asyncio
async def test_github_issue_tracker() -> None:
    config = GitHubConfig(org="acme", repo="app")
    tracker = create_github_issue_tracker(config)
    issue = await tracker.create_issue(CreateIssueInput(title="Bug"))
    assert issue.title == "Bug"
    issues = await tracker.list_issues(IssueFilter())
    assert isinstance(issues, list)


@pytest.mark.asyncio
async def test_github_source_control() -> None:
    config = GitHubConfig(org="acme", repo="app")
    sc = create_github_source_control(config)
    branch = await sc.create_branch(CreateBranchInput(name="feat"))
    assert branch.name == "feat"


@pytest.mark.asyncio
async def test_github_ci_pipeline() -> None:
    config = GitHubConfig(org="acme", repo="app")
    ci = create_github_ci_pipeline(config)
    build = await ci.trigger_build(TriggerBuildInput(branch="main"))
    assert build.status == "queued"
    status = await ci.get_build_status("1")
    assert status.status == "succeeded"
