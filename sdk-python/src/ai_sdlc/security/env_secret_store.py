"""Environment variable-backed SecretStore."""

from __future__ import annotations

import os


def _to_env_var(name: str) -> str:
    return name.replace("-", "_").upper()


class _EnvSecretStore:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = env

    def _get_env(self, key: str) -> str | None:
        if self._env is not None:
            return self._env.get(key)
        return os.environ.get(key)

    def get(self, name: str) -> str | None:
        return self._get_env(_to_env_var(name))

    def get_required(self, name: str) -> str:
        env_var = _to_env_var(name)
        value = self._get_env(env_var)
        if not value:
            msg = (
                f'Secret "{name}" not found: '
                f"environment variable {env_var} is not set"
            )
            raise ValueError(msg)
        return value


def create_env_secret_store(
    env: dict[str, str] | None = None,
) -> _EnvSecretStore:
    """Create a SecretStore backed by environment variables.

    Args:
        env: Optional dict to use instead of ``os.environ``.
    """
    return _EnvSecretStore(env)
