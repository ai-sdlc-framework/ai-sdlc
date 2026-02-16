"""Linear adapter stub — implements IssueTracker interface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

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


@dataclass
class LinearConfig:
    team_id: str
    api_key_secret_ref: str | None = None
    default_labels: list[str] | None = None


class LinearClientLike(Protocol):
    """Minimal protocol for a Linear API client."""

    async def request(self, query: str, variables: dict[str, Any]) -> Any: ...


class _LinearIssueTracker:
    def __init__(
        self, client: LinearClientLike, config: LinearConfig,
    ) -> None:
        self._client = client
        self._config = config

    async def list_issues(self, filter: IssueFilter) -> list[Issue]:
        return []

    async def get_issue(self, id: str) -> Issue:
        return Issue(
            id=id, title="", status="Backlog",
            url=f"https://linear.app/issue/{id}",
        )

    async def create_issue(self, input: CreateIssueInput) -> Issue:
        return Issue(
            id="stub-1", title=input.title, status="Backlog",
            url="https://linear.app/issue/stub-1",
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
        async def _empty() -> AsyncIterator[IssueEvent]:
            return
            yield  # noqa: RET504  # pragma: no cover
        return _empty()


class _NoOpLinearClient:
    async def request(self, query: str, variables: dict[str, Any]) -> Any:
        return None


def create_linear_issue_tracker(
    config: LinearConfig,
    client: LinearClientLike | None = None,
) -> _LinearIssueTracker:
    """Create a Linear IssueTracker adapter."""
    return _LinearIssueTracker(client or _NoOpLinearClient(), config)
