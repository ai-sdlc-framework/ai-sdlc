"""Enterprise security interface Protocols for AI-SDLC Framework."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

# ── Sandbox Isolation ────────────────────────────────────────────────

NetworkPolicy = Literal["none", "egress-only", "full"]
SandboxStatus = Literal["idle", "running", "terminated", "error"]


@dataclass
class SandboxConstraints:
    max_memory_mb: int
    max_cpu_percent: int
    network_policy: NetworkPolicy
    timeout_ms: int
    allowed_paths: list[str]


class Sandbox(Protocol):
    async def isolate(self, task_id: str, constraints: SandboxConstraints) -> str: ...
    async def destroy(self, sandbox_id: str) -> None: ...
    async def get_status(self, sandbox_id: str) -> SandboxStatus: ...


# ── Secret Store ─────────────────────────────────────────────────────


class SecretStore(Protocol):
    def get(self, name: str) -> str | None: ...
    def get_required(self, name: str) -> str: ...


# ── JIT Credential Issuing ───────────────────────────────────────────


@dataclass
class JITCredential:
    id: str
    token: str
    scope: list[str]
    issued_at: str
    expires_at: str


class JITCredentialIssuer(Protocol):
    async def issue(self, agent_id: str, scope: list[str], ttl_ms: int) -> JITCredential: ...
    async def revoke(self, credential_id: str) -> None: ...
    async def is_valid(self, credential_id: str) -> bool: ...


# ── Kill Switch ──────────────────────────────────────────────────────


class KillSwitch(Protocol):
    async def activate(self, reason: str) -> None: ...
    async def deactivate(self) -> None: ...
    async def is_active(self) -> bool: ...
    async def get_reason(self) -> str | None: ...


# ── Approval Workflows ──────────────────────────────────────────────

ApprovalTier = Literal["auto", "peer-review", "team-lead", "security-review"]
ApprovalStatusType = Literal["pending", "approved", "rejected", "expired"]


@dataclass
class ApprovalRequest:
    id: str
    tier: ApprovalTier
    requester: str
    description: str
    status: ApprovalStatusType
    created_at: str
    decided_at: str | None = None
    decided_by: str | None = None


class ApprovalWorkflow(Protocol):
    async def submit(
        self, tier: ApprovalTier, requester: str, description: str
    ) -> ApprovalRequest: ...
    async def approve(self, request_id: str, approver: str) -> ApprovalRequest: ...
    async def reject(
        self, request_id: str, rejector: str, reason: str
    ) -> ApprovalRequest: ...
    async def get_status(self, request_id: str) -> ApprovalRequest: ...
