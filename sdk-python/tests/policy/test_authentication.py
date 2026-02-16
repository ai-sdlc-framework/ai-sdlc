"""Tests for authentication layer."""

import pytest

from ai_sdlc.policy.authentication import (
    AuthIdentity,
    create_always_authenticator,
    create_token_authenticator,
)


@pytest.mark.asyncio
async def test_token_authenticator_valid() -> None:
    identity = AuthIdentity(
        actor="agent-1",
        actor_type="ai-agent",
        roles=["developer"],
        groups=["team-a"],
        scopes=["read", "write"],
    )
    auth = create_token_authenticator({"tok-123": identity})
    result = await auth.authenticate("tok-123")
    assert result.success is True
    assert result.identity is not None
    assert result.identity.actor == "agent-1"


@pytest.mark.asyncio
async def test_token_authenticator_invalid() -> None:
    auth = create_token_authenticator({})
    result = await auth.authenticate("bad-token")
    assert result.success is False
    assert result.reason == "Invalid token"


@pytest.mark.asyncio
async def test_always_authenticator() -> None:
    identity = AuthIdentity(
        actor="admin",
        actor_type="human",
    )
    auth = create_always_authenticator(identity)
    result = await auth.authenticate("anything")
    assert result.success is True
    assert result.identity is not None
    assert result.identity.actor == "admin"
