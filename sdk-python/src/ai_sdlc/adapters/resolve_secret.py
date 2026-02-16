"""Resolve a secretRef to an environment variable value."""

from __future__ import annotations

import os


def resolve_secret(secret_ref: str) -> str:
    """Convert kebab-case secret name to UPPER_SNAKE_CASE env var and read it.

    Raises ``ValueError`` if the env var is not set.
    """
    env_var = secret_ref.replace("-", "_").upper()
    value = os.environ.get(env_var)
    if not value:
        msg = (
            f'Secret "{secret_ref}" not found: '
            f"environment variable {env_var} is not set"
        )
        raise ValueError(msg)
    return value
