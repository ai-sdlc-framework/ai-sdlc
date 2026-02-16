"""GitHub adapter stubs — SourceControl, IssueTracker, CIPipeline.

These are stub/protocol implementations. Real API calls require
an injected Octokit-like client (not bundled as a dependency).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

from ai_sdlc.adapters.interfaces import (
    Branch,
    Build,
    BuildEvent,
    BuildFilter,
    BuildStatus,
    ChangedFile,
    CommitStatus,
    CoverageReport,
    CreateBranchInput,
    CreateIssueInput,
    CreatePRInput,
    FileContent,
    Issue,
    IssueComment,
    IssueEvent,
    IssueFilter,
    MergeResult,
    MergeStrategy,
    PREvent,
    PRFilter,
    PullRequest,
    TestResults,
    TriggerBuildInput,
    UpdateIssueInput,
)


@dataclass
class GitHubConfig:
    org: str
    repo: str | None = None
    token_secret_ref: str | None = None


class GitHubClient(Protocol):
    """Minimal protocol for a GitHub API client."""

    async def request(
        self, method: str, url: str, **kwargs: Any,
    ) -> Any: ...


def _empty_async_iter() -> AsyncIterator[Any]:
    async def _gen() -> AsyncIterator[Any]:
        return
        yield  # noqa: RET504  # pragma: no cover
    return _gen()


class _GitHubIssueTracker:
    def __init__(self, client: GitHubClient, config: GitHubConfig) -> None:
        self._client = client
        self._config = config

    async def list_issues(self, filter: IssueFilter) -> list[Issue]:
        return []

    async def get_issue(self, id: str) -> Issue:
        return Issue(
            id=id, title="", status="open",
            url=f"https://github.com/{self._config.org}/{self._config.repo}/issues/{id}",
        )

    async def create_issue(self, input: CreateIssueInput) -> Issue:
        return Issue(
            id="1", title=input.title, status="open",
            url=f"https://github.com/{self._config.org}/{self._config.repo}/issues/1",
            description=input.description, labels=input.labels,
            assignee=input.assignee,
        )

    async def update_issue(self, id: str, input: UpdateIssueInput) -> Issue:
        return await self.get_issue(id)

    async def transition_issue(self, id: str, transition: str) -> Issue:
        return await self.get_issue(id)

    async def add_comment(self, id: str, body: str) -> None:
        pass

    async def get_comments(self, id: str) -> list[IssueComment]:
        return []

    def watch_issues(self, filter: IssueFilter) -> AsyncIterator[IssueEvent]:
        return _empty_async_iter()


class _GitHubSourceControl:
    def __init__(self, client: GitHubClient, config: GitHubConfig) -> None:
        self._client = client
        self._config = config

    async def create_branch(self, input: CreateBranchInput) -> Branch:
        return Branch(name=input.name, sha="stub-sha")

    async def create_pr(self, input: CreatePRInput) -> PullRequest:
        return PullRequest(
            id="1", title=input.title,
            source_branch=input.source_branch,
            target_branch=input.target_branch,
            status="open", author="stub-user",
            url=f"https://github.com/{self._config.org}/{self._config.repo}/pull/1",
            description=input.description,
        )

    async def merge_pr(self, id: str, strategy: MergeStrategy) -> MergeResult:
        return MergeResult(sha="merge-sha", merged=True)

    async def get_file_contents(self, path: str, ref: str) -> FileContent:
        return FileContent(path=path, content="", encoding="utf-8")

    async def list_changed_files(self, pr_id: str) -> list[ChangedFile]:
        return []

    async def set_commit_status(
        self, sha: str, status: CommitStatus,
    ) -> None:
        pass

    def watch_pr_events(self, filter: PRFilter) -> AsyncIterator[PREvent]:
        return _empty_async_iter()


class _GitHubCIPipeline:
    def __init__(self, client: GitHubClient, config: GitHubConfig) -> None:
        self._client = client
        self._config = config

    async def trigger_build(self, input: TriggerBuildInput) -> Build:
        return Build(id="1", status="queued")

    async def get_build_status(self, id: str) -> BuildStatus:
        return BuildStatus(id=id, status="succeeded")

    async def get_test_results(self, build_id: str) -> TestResults:
        return TestResults(passed=0, failed=0, skipped=0)

    async def get_coverage_report(self, build_id: str) -> CoverageReport:
        return CoverageReport(line_coverage=0.0)

    def watch_build_events(
        self, filter: BuildFilter,
    ) -> AsyncIterator[BuildEvent]:
        return _empty_async_iter()


def create_github_issue_tracker(
    config: GitHubConfig, client: GitHubClient | None = None,
) -> _GitHubIssueTracker:
    """Create a GitHub IssueTracker adapter."""
    return _GitHubIssueTracker(client or _NoOpClient(), config)


def create_github_source_control(
    config: GitHubConfig, client: GitHubClient | None = None,
) -> _GitHubSourceControl:
    """Create a GitHub SourceControl adapter."""
    return _GitHubSourceControl(client or _NoOpClient(), config)


def create_github_ci_pipeline(
    config: GitHubConfig, client: GitHubClient | None = None,
) -> _GitHubCIPipeline:
    """Create a GitHub CIPipeline adapter."""
    return _GitHubCIPipeline(client or _NoOpClient(), config)


class _NoOpClient:
    async def request(
        self, method: str, url: str, **kwargs: Any,
    ) -> Any:
        return None
