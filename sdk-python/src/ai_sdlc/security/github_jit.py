"""GitHub Secrets-based JIT credential issuer."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from .interfaces import JITCredential


class SecretsClient(Protocol):
    """Minimal protocol for GitHub Actions Secrets API."""

    async def get_repo_public_key(
        self, owner: str, repo: str,
    ) -> dict[str, str]: ...

    async def create_or_update_secret(
        self, owner: str, repo: str, secret_name: str,
        encrypted_value: str, key_id: str,
    ) -> None: ...

    async def delete_secret(
        self, owner: str, repo: str, secret_name: str,
    ) -> None: ...


SecretEncryptor = Callable[
    [str, str], Coroutine[object, object, str]
]


@dataclass
class GitHubJITConfig:
    owner: str
    repo: str
    secret_prefix: str = "JIT_CRED_"
    encryptor: SecretEncryptor | None = None


def _to_secret_name(prefix: str, agent_id: str, cred_id: str) -> str:
    sanitized = "".join(
        c if c.isalnum() else "_" for c in agent_id
    ).upper()
    return f"{prefix}{sanitized}_{cred_id}"


async def _default_encryptor(value: str, _public_key: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class _GitHubJIT:
    def __init__(
        self, client: SecretsClient, config: GitHubJITConfig,
    ) -> None:
        self._client = client
        self._config = config
        self._encryptor = config.encryptor or _default_encryptor
        self._credentials: dict[str, tuple[JITCredential, str]] = {}
        self._revoked: set[str] = set()
        self._next_id = 1

    async def issue(
        self, agent_id: str, scope: list[str], ttl_ms: int,
    ) -> JITCredential:
        cid = f"ghcred-{self._next_id}"
        self._next_id += 1
        token = secrets.token_hex(32)
        now = datetime.now(UTC)
        secret_name = _to_secret_name(
            self._config.secret_prefix, agent_id, cid,
        )

        pub_key = await self._client.get_repo_public_key(
            self._config.owner, self._config.repo,
        )
        encrypted = await self._encryptor(token, pub_key["key"])

        await self._client.create_or_update_secret(
            self._config.owner, self._config.repo,
            secret_name, encrypted, pub_key["key_id"],
        )

        cred = JITCredential(
            id=cid,
            token=token,
            scope=scope,
            issued_at=now.isoformat(),
            expires_at=(now + timedelta(milliseconds=ttl_ms)).isoformat(),
        )
        self._credentials[cid] = (cred, secret_name)
        return cred

    async def revoke(self, credential_id: str) -> None:
        entry = self._credentials.get(credential_id)
        if not entry:
            raise KeyError(f'Credential "{credential_id}" not found')
        _, secret_name = entry
        await self._client.delete_secret(
            self._config.owner, self._config.repo, secret_name,
        )
        self._revoked.add(credential_id)

    async def is_valid(self, credential_id: str) -> bool:
        entry = self._credentials.get(credential_id)
        if not entry:
            return False
        if credential_id in self._revoked:
            return False
        cred, _ = entry
        return (
            datetime.fromisoformat(cred.expires_at) > datetime.now(UTC)
        )


def create_github_jit_credential_issuer(
    client: SecretsClient, config: GitHubJITConfig,
) -> _GitHubJIT:
    """Create a GitHub Secrets-based JIT credential issuer."""
    return _GitHubJIT(client, config)
