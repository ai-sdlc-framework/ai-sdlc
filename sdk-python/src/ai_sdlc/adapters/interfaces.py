"""Adapter interface contracts translated from spec/adapters.md.

Each interface defines the methods an adapter MUST provide.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

# ── IssueTracker ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class IssueFilter:
    status: str | None = None
    labels: list[str] | None = None
    assignee: str | None = None
    project: str | None = None


@dataclass(frozen=True)
class Issue:
    id: str
    title: str
    status: str
    url: str
    description: str | None = None
    labels: list[str] | None = None
    assignee: str | None = None


@dataclass(frozen=True)
class CreateIssueInput:
    title: str
    description: str | None = None
    labels: list[str] | None = None
    assignee: str | None = None
    project: str | None = None


@dataclass(frozen=True)
class UpdateIssueInput:
    title: str | None = None
    description: str | None = None
    labels: list[str] | None = None
    assignee: str | None = None


@dataclass(frozen=True)
class IssueEvent:
    type: Literal["created", "updated", "transitioned"]
    issue: Issue
    timestamp: str


@dataclass(frozen=True)
class IssueComment:
    body: str


@runtime_checkable
class IssueTracker(Protocol):
    async def list_issues(self, filter: IssueFilter) -> list[Issue]: ...
    async def get_issue(self, id: str) -> Issue: ...
    async def create_issue(self, input: CreateIssueInput) -> Issue: ...
    async def update_issue(self, id: str, input: UpdateIssueInput) -> Issue: ...
    async def transition_issue(self, id: str, transition: str) -> Issue: ...
    async def add_comment(self, id: str, body: str) -> None: ...
    async def get_comments(self, id: str) -> list[IssueComment]: ...
    def watch_issues(self, filter: IssueFilter) -> AsyncIterator[IssueEvent]: ...


# ── SourceControl ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class CreateBranchInput:
    name: str
    from_ref: str | None = None


@dataclass(frozen=True)
class Branch:
    name: str
    sha: str


@dataclass(frozen=True)
class CreatePRInput:
    title: str
    source_branch: str
    target_branch: str
    description: str | None = None


MergeStrategy = Literal["merge", "squash", "rebase"]


@dataclass(frozen=True)
class PullRequest:
    id: str
    title: str
    source_branch: str
    target_branch: str
    status: Literal["open", "merged", "closed"]
    author: str
    url: str
    description: str | None = None


@dataclass(frozen=True)
class MergeResult:
    sha: str
    merged: bool


@dataclass(frozen=True)
class FileContent:
    path: str
    content: str
    encoding: str


@dataclass(frozen=True)
class ChangedFile:
    path: str
    status: Literal["added", "modified", "deleted", "renamed"]
    additions: int
    deletions: int


@dataclass(frozen=True)
class CommitStatus:
    state: Literal["pending", "success", "failure", "error"]
    context: str
    description: str | None = None
    target_url: str | None = None


@dataclass(frozen=True)
class PRFilter:
    status: str | None = None
    author: str | None = None
    target_branch: str | None = None


@dataclass(frozen=True)
class PREvent:
    type: Literal["opened", "updated", "merged", "closed"]
    pull_request: PullRequest
    timestamp: str


@runtime_checkable
class SourceControl(Protocol):
    async def create_branch(self, input: CreateBranchInput) -> Branch: ...
    async def create_pr(self, input: CreatePRInput) -> PullRequest: ...
    async def merge_pr(self, id: str, strategy: MergeStrategy) -> MergeResult: ...
    async def get_file_contents(self, path: str, ref: str) -> FileContent: ...
    async def list_changed_files(self, pr_id: str) -> list[ChangedFile]: ...
    async def set_commit_status(self, sha: str, status: CommitStatus) -> None: ...
    def watch_pr_events(self, filter: PRFilter) -> AsyncIterator[PREvent]: ...


# ── CIPipeline ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TriggerBuildInput:
    branch: str
    commit_sha: str | None = None
    parameters: dict[str, str] | None = None


@dataclass(frozen=True)
class Build:
    id: str
    status: str
    url: str | None = None


@dataclass(frozen=True)
class BuildStatus:
    id: str
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    started_at: str | None = None
    completed_at: str | None = None


@dataclass(frozen=True)
class TestResults:
    passed: int
    failed: int
    skipped: int
    duration: float | None = None


@dataclass(frozen=True)
class CoverageReport:
    line_coverage: float
    branch_coverage: float | None = None
    function_coverage: float | None = None


@dataclass(frozen=True)
class BuildFilter:
    branch: str | None = None
    status: str | None = None


@dataclass(frozen=True)
class BuildEvent:
    type: Literal["started", "completed", "failed"]
    build: Build
    timestamp: str


@runtime_checkable
class CIPipeline(Protocol):
    async def trigger_build(self, input: TriggerBuildInput) -> Build: ...
    async def get_build_status(self, id: str) -> BuildStatus: ...
    async def get_test_results(self, build_id: str) -> TestResults: ...
    async def get_coverage_report(self, build_id: str) -> CoverageReport: ...
    def watch_build_events(self, filter: BuildFilter) -> AsyncIterator[BuildEvent]: ...


# ── CodeAnalysis ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScanInput:
    repository: str
    branch: str | None = None
    commit_sha: str | None = None
    rulesets: list[str] | None = None


@dataclass(frozen=True)
class ScanResult:
    id: str
    status: Literal["pending", "running", "completed", "failed"]


Severity = Literal["low", "medium", "high", "critical"]


@dataclass(frozen=True)
class Finding:
    id: str
    severity: Severity
    message: str
    file: str
    rule: str
    line: int | None = None


@dataclass(frozen=True)
class SeveritySummary:
    critical: int
    high: int
    medium: int
    low: int


@runtime_checkable
class CodeAnalysis(Protocol):
    async def run_scan(self, input: ScanInput) -> ScanResult: ...
    async def get_findings(self, scan_id: str) -> list[Finding]: ...
    async def get_severity_summary(self, scan_id: str) -> SeveritySummary: ...


# ── Messenger ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class NotificationInput:
    channel: str
    message: str
    severity: Literal["info", "warning", "error"] | None = None


@dataclass(frozen=True)
class ThreadInput:
    channel: str
    title: str
    message: str


@dataclass(frozen=True)
class Thread:
    id: str
    url: str


@runtime_checkable
class Messenger(Protocol):
    async def send_notification(self, input: NotificationInput) -> None: ...
    async def create_thread(self, input: ThreadInput) -> Thread: ...
    async def post_update(self, thread_id: str, message: str) -> None: ...


# ── DeploymentTarget ──────────────────────────────────────────────────

@dataclass(frozen=True)
class DeployInput:
    artifact: str
    environment: str
    version: str
    parameters: dict[str, str] | None = None


@dataclass(frozen=True)
class Deployment:
    id: str
    status: str
    environment: str
    url: str | None = None


@dataclass(frozen=True)
class DeploymentStatus:
    id: str
    status: Literal["pending", "in-progress", "succeeded", "failed", "rolled-back"]
    environment: str
    timestamp: str


@dataclass(frozen=True)
class DeployFilter:
    environment: str | None = None
    status: str | None = None


@dataclass(frozen=True)
class DeployEvent:
    type: Literal["started", "succeeded", "failed", "rolled-back"]
    deployment: Deployment
    timestamp: str


@runtime_checkable
class DeploymentTarget(Protocol):
    async def deploy(self, input: DeployInput) -> Deployment: ...
    async def get_deployment_status(self, id: str) -> DeploymentStatus: ...
    async def rollback(self, id: str) -> Deployment: ...
    def watch_deployment_events(self, filter: DeployFilter) -> AsyncIterator[DeployEvent]: ...


# ── EventBus ─────────────────────────────────────────────────────────

@runtime_checkable
class EventBus(Protocol):
    async def publish(self, topic: str, payload: Any) -> None: ...
    def subscribe(self, topic: str, handler: Any) -> Any: ...
