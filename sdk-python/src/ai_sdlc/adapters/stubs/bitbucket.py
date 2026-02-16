"""Stub Bitbucket adapter for testing."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

from ai_sdlc.adapters.interfaces import (
    Branch,
    ChangedFile,
    CommitStatus,
    CreateBranchInput,
    CreatePRInput,
    FileContent,
    MergeResult,
    MergeStrategy,
    PREvent,
    PRFilter,
    PullRequest,
)


class StubBitbucketAdapter:
    def __init__(self) -> None:
        self._branches: dict[str, Branch] = {}
        self._prs: dict[str, PullRequest] = {}
        self._next_pr_id = 1

    async def create_branch(self, input: CreateBranchInput) -> Branch:
        branch = Branch(name=input.name, sha=f"sha-bb-{input.name}")
        self._branches[input.name] = branch
        return branch

    async def create_pr(self, input: CreatePRInput) -> PullRequest:
        pid = f"bb-pr-{self._next_pr_id}"
        self._next_pr_id += 1
        pr = PullRequest(
            id=pid, title=input.title,
            source_branch=input.source_branch,
            target_branch=input.target_branch,
            status="open", author="stub-user",
            url=f"https://bitbucket.org/pull-requests/{pid}",
            description=input.description,
        )
        self._prs[pid] = pr
        return pr

    async def merge_pr(self, id: str, strategy: MergeStrategy) -> MergeResult:
        if id not in self._prs:
            raise KeyError(f'PR "{id}" not found')
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
        async def _empty() -> AsyncIterator[PREvent]:
            return
            yield  # noqa: RET504  # pragma: no cover
        return _empty()

    def get_branch_count(self) -> int:
        return len(self._branches)

    def get_pr_count(self) -> int:
        return len(self._prs)


def create_stub_bitbucket() -> StubBitbucketAdapter:
    return StubBitbucketAdapter()
