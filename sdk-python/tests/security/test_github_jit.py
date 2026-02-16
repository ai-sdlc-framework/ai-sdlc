"""Tests for GitHub JIT credential issuer."""

from __future__ import annotations

import pytest

from ai_sdlc.security.github_jit import GitHubJITConfig, create_github_jit_credential_issuer


class MockSecretsClient:
    def __init__(self) -> None:
        self.secrets: dict[str, str] = {}
        self.deleted: list[str] = []

    async def get_repo_public_key(
        self, owner: str, repo: str,
    ) -> dict[str, str]:
        return {"key_id": "key-1", "key": "pubkey-base64"}

    async def create_or_update_secret(
        self, owner: str, repo: str, secret_name: str,
        encrypted_value: str, key_id: str,
    ) -> None:
        self.secrets[secret_name] = encrypted_value

    async def delete_secret(
        self, owner: str, repo: str, secret_name: str,
    ) -> None:
        self.deleted.append(secret_name)
        self.secrets.pop(secret_name, None)


@pytest.mark.asyncio
async def test_issue_and_validate() -> None:
    client = MockSecretsClient()
    jit = create_github_jit_credential_issuer(
        client,
        GitHubJITConfig(owner="acme", repo="app"),
    )
    cred = await jit.issue("agent-1", ["read", "write"], ttl_ms=60_000)
    assert cred.id.startswith("ghcred-")
    assert len(cred.token) == 64  # 32 bytes hex
    assert cred.scope == ["read", "write"]
    assert len(client.secrets) == 1

    valid = await jit.is_valid(cred.id)
    assert valid


@pytest.mark.asyncio
async def test_revoke() -> None:
    client = MockSecretsClient()
    jit = create_github_jit_credential_issuer(
        client,
        GitHubJITConfig(owner="acme", repo="app"),
    )
    cred = await jit.issue("agent-2", ["read"], ttl_ms=60_000)
    await jit.revoke(cred.id)
    assert len(client.deleted) == 1

    valid = await jit.is_valid(cred.id)
    assert not valid


@pytest.mark.asyncio
async def test_is_valid_unknown() -> None:
    client = MockSecretsClient()
    jit = create_github_jit_credential_issuer(
        client,
        GitHubJITConfig(owner="acme", repo="app"),
    )
    assert not await jit.is_valid("nonexistent")
