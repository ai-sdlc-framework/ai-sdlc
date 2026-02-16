"""Authentication layer for AI-SDLC Framework.

Provides token-based identity verification for agents and services.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol


@dataclass(frozen=True)
class AuthIdentity:
    actor: str
    actor_type: Literal["ai-agent", "human", "bot", "service-account"]
    roles: list[str] = field(default_factory=list)
    groups: list[str] = field(default_factory=list)
    scopes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AuthenticationResult:
    success: bool
    identity: AuthIdentity | None = None
    reason: str | None = None


class Authenticator(Protocol):
    async def authenticate(self, token: str) -> AuthenticationResult: ...


def create_token_authenticator(token_map: dict[str, AuthIdentity]) -> Authenticator:
    """Create a token-based authenticator backed by a simple dict.

    Suitable for testing and development.
    """

    class _TokenAuth:
        async def authenticate(self, token: str) -> AuthenticationResult:
            identity = token_map.get(token)
            if identity is None:
                return AuthenticationResult(success=False, reason="Invalid token")
            return AuthenticationResult(success=True, identity=identity)

    return _TokenAuth()


def create_always_authenticator(identity: AuthIdentity) -> Authenticator:
    """Create an authenticator that always succeeds with the given identity.

    Useful for testing and development environments.
    """

    class _AlwaysAuth:
        async def authenticate(self, _token: str) -> AuthenticationResult:
            return AuthenticationResult(success=True, identity=identity)

    return _AlwaysAuth()
