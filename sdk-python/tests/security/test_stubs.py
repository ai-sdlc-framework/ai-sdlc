"""Tests for security stub implementations."""

import pytest

from ai_sdlc.security.interfaces import SandboxConstraints
from ai_sdlc.security.stubs import (
    create_stub_approval_workflow,
    create_stub_jit_credential_issuer,
    create_stub_kill_switch,
    create_stub_sandbox,
)


@pytest.mark.asyncio
async def test_stub_sandbox() -> None:
    sb = create_stub_sandbox()
    constraints = SandboxConstraints(
        max_memory_mb=512,
        max_cpu_percent=50,
        network_policy="none",
        timeout_ms=30000,
        allowed_paths=["/tmp"],
    )
    sid = await sb.isolate("task-1", constraints)
    assert await sb.get_status(sid) == "running"
    await sb.destroy(sid)
    assert await sb.get_status(sid) == "terminated"


@pytest.mark.asyncio
async def test_stub_jit() -> None:
    jit = create_stub_jit_credential_issuer()
    cred = await jit.issue("agent-1", ["read", "write"], 60_000)
    assert cred.token.startswith("tok-agent-1")
    assert await jit.is_valid(cred.id)
    await jit.revoke(cred.id)
    assert not await jit.is_valid(cred.id)


@pytest.mark.asyncio
async def test_stub_kill_switch() -> None:
    ks = create_stub_kill_switch()
    assert not await ks.is_active()
    await ks.activate("emergency")
    assert await ks.is_active()
    assert await ks.get_reason() == "emergency"
    await ks.deactivate()
    assert not await ks.is_active()


@pytest.mark.asyncio
async def test_stub_approval_workflow() -> None:
    wf = create_stub_approval_workflow()
    req = await wf.submit("peer-review", "alice", "deploy feature")
    assert req.status == "pending"
    approved = await wf.approve(req.id, "bob")
    assert approved.status == "approved"
    assert approved.decided_by == "bob"


@pytest.mark.asyncio
async def test_auto_approval() -> None:
    wf = create_stub_approval_workflow()
    req = await wf.submit("auto", "alice", "trivial change")
    assert req.status == "approved"
    assert req.decided_by == "system"
