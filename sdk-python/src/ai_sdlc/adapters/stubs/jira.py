"""Stub Jira adapter for testing."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

from ai_sdlc.adapters.interfaces import (
    CreateIssueInput,
    Issue,
    IssueComment,
    IssueEvent,
    IssueFilter,
    UpdateIssueInput,
)


class StubJiraAdapter:
    def __init__(self) -> None:
        self._issues: dict[str, Issue] = {}
        self._comments: dict[str, list[str]] = {}
        self._next_id = 1

    async def list_issues(self, filter: IssueFilter) -> list[Issue]:
        result = list(self._issues.values())
        if filter.status:
            result = [i for i in result if i.status == filter.status]
        if filter.labels:
            result = [
                i for i in result
                if i.labels and any(lbl in i.labels for lbl in filter.labels)
            ]
        if filter.assignee:
            result = [i for i in result if i.assignee == filter.assignee]
        return result

    async def get_issue(self, id: str) -> Issue:
        if id not in self._issues:
            raise KeyError(f'Issue "{id}" not found')
        return self._issues[id]

    async def create_issue(self, input: CreateIssueInput) -> Issue:
        iid = f"JIRA-{self._next_id}"
        self._next_id += 1
        issue = Issue(
            id=iid, title=input.title, status="open",
            url=f"https://jira.example.com/browse/{iid}",
            description=input.description,
            labels=input.labels, assignee=input.assignee,
        )
        self._issues[iid] = issue
        return issue

    async def update_issue(self, id: str, input: UpdateIssueInput) -> Issue:
        old = self._issues.get(id)
        if not old:
            raise KeyError(f'Issue "{id}" not found')
        self._issues[id] = Issue(
            id=old.id,
            title=input.title if input.title is not None else old.title,
            status=old.status,
            url=old.url,
            description=(
                input.description
                if input.description is not None
                else old.description
            ),
            labels=input.labels if input.labels is not None else old.labels,
            assignee=(
                input.assignee if input.assignee is not None else old.assignee
            ),
        )
        return self._issues[id]

    async def transition_issue(self, id: str, transition: str) -> Issue:
        old = self._issues.get(id)
        if not old:
            raise KeyError(f'Issue "{id}" not found')
        self._issues[id] = Issue(
            id=old.id, title=old.title, status=transition,
            url=old.url, description=old.description,
            labels=old.labels, assignee=old.assignee,
        )
        return self._issues[id]

    async def add_comment(self, id: str, body: str) -> None:
        if id not in self._issues:
            raise KeyError(f'Issue "{id}" not found')
        self._comments.setdefault(id, []).append(body)

    async def get_comments(self, id: str) -> list[IssueComment]:
        return [IssueComment(body=b) for b in self._comments.get(id, [])]

    def watch_issues(
        self, filter: IssueFilter,
    ) -> AsyncIterator[IssueEvent]:
        async def _empty() -> AsyncIterator[IssueEvent]:
            return
            yield  # noqa: RET504  # pragma: no cover
        return _empty()

    def get_issue_count(self) -> int:
        return len(self._issues)


def create_stub_jira() -> StubJiraAdapter:
    return StubJiraAdapter()
