"""Stub GitLab CI and Source adapters for testing."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

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
    CreatePRInput,
    FileContent,
    MergeResult,
    MergeStrategy,
    PREvent,
    PRFilter,
    PullRequest,
    TestResults,
    TriggerBuildInput,
)


def _empty_async_iter() -> AsyncIterator[object]:
    async def _gen() -> AsyncIterator[object]:
        return
        yield  # noqa: RET504  # pragma: no cover
    return _gen()


class StubGitLabCIAdapter:
    def __init__(self) -> None:
        self._builds: dict[str, Build] = {}
        self._next_id = 1

    async def trigger_build(self, input: TriggerBuildInput) -> Build:
        bid = f"gl-build-{self._next_id}"
        self._next_id += 1
        build = Build(
            id=bid, status="running",
            url=f"https://gitlab.example.com/builds/{bid}",
        )
        self._builds[bid] = build
        return build

    async def get_build_status(self, id: str) -> BuildStatus:
        if id not in self._builds:
            raise KeyError(f'Build "{id}" not found')
        return BuildStatus(
            id=id, status="succeeded",
            started_at=datetime.now(UTC).isoformat(),
            completed_at=datetime.now(UTC).isoformat(),
        )

    async def get_test_results(self, build_id: str) -> TestResults:
        return TestResults(passed=10, failed=0, skipped=0)

    async def get_coverage_report(self, build_id: str) -> CoverageReport:
        return CoverageReport(line_coverage=85.0)

    def watch_build_events(
        self, filter: BuildFilter,
    ) -> AsyncIterator[BuildEvent]:
        return _empty_async_iter()  # type: ignore[return-value]

    def get_build_count(self) -> int:
        return len(self._builds)


class StubGitLabSourceAdapter:
    def __init__(self) -> None:
        self._branches: dict[str, Branch] = {}
        self._prs: dict[str, PullRequest] = {}
        self._next_pr_id = 1

    async def create_branch(self, input: CreateBranchInput) -> Branch:
        branch = Branch(name=input.name, sha=f"sha-gl-{input.name}")
        self._branches[input.name] = branch
        return branch

    async def create_pr(self, input: CreatePRInput) -> PullRequest:
        pid = f"gl-mr-{self._next_pr_id}"
        self._next_pr_id += 1
        pr = PullRequest(
            id=pid, title=input.title,
            source_branch=input.source_branch,
            target_branch=input.target_branch,
            status="open", author="stub-user",
            url=f"https://gitlab.example.com/merge_requests/{pid}",
            description=input.description,
        )
        self._prs[pid] = pr
        return pr

    async def merge_pr(self, id: str, strategy: MergeStrategy) -> MergeResult:
        if id not in self._prs:
            raise KeyError(f'MR "{id}" not found')
        return MergeResult(sha=f"merge-sha-{id}", merged=True)

    async def get_file_contents(self, path: str, ref: str) -> FileContent:
        return FileContent(path=path, content="", encoding="utf-8")

    async def list_changed_files(self, pr_id: str) -> list[ChangedFile]:
        return []

    async def set_commit_status(
        self, sha: str, status: CommitStatus,
    ) -> None:
        pass

    def watch_pr_events(self, filter: PRFilter) -> AsyncIterator[PREvent]:
        return _empty_async_iter()  # type: ignore[return-value]

    def get_branch_count(self) -> int:
        return len(self._branches)

    def get_pr_count(self) -> int:
        return len(self._prs)


def create_stub_gitlab_ci() -> StubGitLabCIAdapter:
    return StubGitLabCIAdapter()


def create_stub_gitlab_source() -> StubGitLabSourceAdapter:
    return StubGitLabSourceAdapter()
