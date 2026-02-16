"""Stub (in-memory) implementations of enterprise security interfaces."""

from __future__ import annotations

from datetime import UTC, datetime

from .interfaces import (
    ApprovalRequest,
    ApprovalTier,
    JITCredential,
    SandboxConstraints,
    SandboxStatus,
)


class StubSandbox:
    def __init__(self) -> None:
        self._sandboxes: dict[str, SandboxStatus] = {}
        self._next_id = 1

    async def isolate(self, task_id: str, constraints: SandboxConstraints) -> str:
        sid = f"sandbox-{self._next_id}"
        self._next_id += 1
        self._sandboxes[sid] = "running"
        return sid

    async def destroy(self, sandbox_id: str) -> None:
        if sandbox_id not in self._sandboxes:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        self._sandboxes[sandbox_id] = "terminated"

    async def get_status(self, sandbox_id: str) -> SandboxStatus:
        if sandbox_id not in self._sandboxes:
            raise KeyError(f'Sandbox "{sandbox_id}" not found')
        return self._sandboxes[sandbox_id]


class StubJITCredentialIssuer:
    def __init__(self) -> None:
        self._credentials: dict[str, JITCredential] = {}
        self._revoked: set[str] = set()
        self._next_id = 1

    async def issue(self, agent_id: str, scope: list[str], ttl_ms: int) -> JITCredential:
        cid = f"cred-{self._next_id}"
        self._next_id += 1
        now = datetime.now(UTC)
        from datetime import timedelta

        cred = JITCredential(
            id=cid,
            token=f"tok-{agent_id}-{cid}",
            scope=scope,
            issued_at=now.isoformat(),
            expires_at=(now + timedelta(milliseconds=ttl_ms)).isoformat(),
        )
        self._credentials[cid] = cred
        return cred

    async def revoke(self, credential_id: str) -> None:
        if credential_id not in self._credentials:
            raise KeyError(f'Credential "{credential_id}" not found')
        self._revoked.add(credential_id)

    async def is_valid(self, credential_id: str) -> bool:
        cred = self._credentials.get(credential_id)
        if not cred:
            return False
        if credential_id in self._revoked:
            return False
        return datetime.fromisoformat(cred.expires_at) > datetime.now(UTC)


class StubKillSwitch:
    def __init__(self) -> None:
        self._active = False
        self._reason: str | None = None

    async def activate(self, reason: str) -> None:
        self._active = True
        self._reason = reason

    async def deactivate(self) -> None:
        self._active = False
        self._reason = None

    async def is_active(self) -> bool:
        return self._active

    async def get_reason(self) -> str | None:
        return self._reason if self._active else None


class StubApprovalWorkflow:
    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}
        self._next_id = 1

    async def submit(
        self, tier: ApprovalTier, requester: str, description: str
    ) -> ApprovalRequest:
        rid = f"approval-{self._next_id}"
        self._next_id += 1
        now = datetime.now(UTC).isoformat()
        req = ApprovalRequest(
            id=rid,
            tier=tier,
            requester=requester,
            description=description,
            status="approved" if tier == "auto" else "pending",
            created_at=now,
            decided_at=now if tier == "auto" else None,
            decided_by="system" if tier == "auto" else None,
        )
        self._requests[rid] = req
        return req

    async def approve(self, request_id: str, approver: str) -> ApprovalRequest:
        req = self._requests.get(request_id)
        if not req:
            raise KeyError(f'Approval request "{request_id}" not found')
        if req.status != "pending":
            raise ValueError(f'Request "{request_id}" is not pending')
        updated = ApprovalRequest(
            id=req.id,
            tier=req.tier,
            requester=req.requester,
            description=req.description,
            status="approved",
            created_at=req.created_at,
            decided_at=datetime.now(UTC).isoformat(),
            decided_by=approver,
        )
        self._requests[request_id] = updated
        return updated

    async def reject(
        self, request_id: str, rejector: str, reason: str
    ) -> ApprovalRequest:
        req = self._requests.get(request_id)
        if not req:
            raise KeyError(f'Approval request "{request_id}" not found')
        if req.status != "pending":
            raise ValueError(f'Request "{request_id}" is not pending')
        updated = ApprovalRequest(
            id=req.id,
            tier=req.tier,
            requester=req.requester,
            description=req.description,
            status="rejected",
            created_at=req.created_at,
            decided_at=datetime.now(UTC).isoformat(),
            decided_by=rejector,
        )
        self._requests[request_id] = updated
        return updated

    async def get_status(self, request_id: str) -> ApprovalRequest:
        req = self._requests.get(request_id)
        if not req:
            raise KeyError(f'Approval request "{request_id}" not found')
        return req


def create_stub_sandbox() -> StubSandbox:
    return StubSandbox()


def create_stub_jit_credential_issuer() -> StubJITCredentialIssuer:
    return StubJITCredentialIssuer()


def create_stub_kill_switch() -> StubKillSwitch:
    return StubKillSwitch()


def create_stub_approval_workflow() -> StubApprovalWorkflow:
    return StubApprovalWorkflow()
