"""Authorization enforcement from PRD Sections 15.1-15.2.

3-layer defense model:
1. Permissions - level-based read/write/execute glob matching
2. Constraints - agent-specific blockedPaths, allowedLanguages
3. Guardrails - approval requirements, line limits, etc.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from ai_sdlc.core.types import (
        AgentConstraints,
        AutonomyPolicy,
        Permissions,
    )


@dataclass(frozen=True)
class AuthorizationContext:
    agent: str
    action: Literal["read", "write", "execute"]
    target: str


@dataclass(frozen=True)
class AuthorizationResult:
    allowed: bool
    reason: str | None = None
    layer: Literal["permissions", "constraints"] | None = None


AuthorizationHook = Callable[[AuthorizationContext], AuthorizationResult]


def _glob_match(pattern: str, target: str) -> bool:
    """Simple glob matching: supports * (any segment) and ** (any path)."""
    if pattern == target:
        return True
    escaped = re.escape(pattern)
    # Order matters: replace \*\* first, then \*
    escaped = escaped.replace(r"\*\*", "<<GLOBSTAR>>")
    escaped = escaped.replace(r"\*", "[^/]*")
    escaped = escaped.replace("<<GLOBSTAR>>", ".*")
    return bool(re.fullmatch(escaped, target))


LANGUAGE_EXTENSIONS: dict[str, list[str]] = {
    "typescript": [".ts", ".tsx", ".mts", ".cts"],
    "javascript": [".js", ".jsx", ".mjs", ".cjs"],
    "python": [".py", ".pyi"],
    "rust": [".rs"],
    "go": [".go"],
    "java": [".java"],
    "ruby": [".rb"],
    "csharp": [".cs"],
    "cpp": [".cpp", ".cc", ".cxx", ".h", ".hpp"],
    "c": [".c", ".h"],
}


def check_permission(
    permissions: Permissions,
    action: Literal["read", "write", "execute"],
    target: str,
) -> AuthorizationResult:
    """Check if a permission set allows the given action on the target."""
    patterns: list[str] | None = getattr(permissions, action, None)
    if not patterns:
        return AuthorizationResult(
            allowed=False,
            reason=f"No {action} permissions defined",
            layer="permissions",
        )
    matched = any(_glob_match(p, target) for p in patterns)
    if not matched:
        return AuthorizationResult(
            allowed=False,
            reason=f'Target "{target}" not matched by {action} permissions',
            layer="permissions",
        )
    return AuthorizationResult(allowed=True)


def check_constraints(
    constraints: AgentConstraints,
    target: str,
) -> AuthorizationResult:
    """Check if agent constraints allow the target."""
    if constraints.blocked_paths:
        for blocked in constraints.blocked_paths:
            if _glob_match(blocked, target):
                return AuthorizationResult(
                    allowed=False,
                    reason=f'Target "{target}" matches blocked path "{blocked}"',
                    layer="constraints",
                )

    if constraints.allowed_languages and len(constraints.allowed_languages) > 0 and "." in target:
        ext = "." + target.rsplit(".", 1)[-1]
        allowed_exts: list[str] = []
        for lang in constraints.allowed_languages:
            allowed_exts.extend(LANGUAGE_EXTENSIONS.get(lang.lower(), []))
        if allowed_exts and ext not in allowed_exts:
            return AuthorizationResult(
                allowed=False,
                reason=f'File extension "{ext}" not in allowed languages',
                layer="constraints",
            )

    return AuthorizationResult(allowed=True)


def authorize(
    permissions: Permissions,
    constraints: AgentConstraints | None,
    action: Literal["read", "write", "execute"],
    target: str,
) -> AuthorizationResult:
    """Composite authorization: checks permissions then constraints."""
    perm_result = check_permission(permissions, action, target)
    if not perm_result.allowed:
        return perm_result

    if constraints and action == "write":
        constraint_result = check_constraints(constraints, target)
        if not constraint_result.allowed:
            return constraint_result

    return AuthorizationResult(allowed=True)


def create_authorization_hook(
    policy: AutonomyPolicy,
    agent_levels: dict[str, int],
    agent_constraints: dict[str, AgentConstraints],
) -> AuthorizationHook:
    """Create an authorization hook for the executor.

    Resolves the agent's current autonomy level to its permissions,
    then checks against the agent's constraints.
    """

    def hook(ctx: AuthorizationContext) -> AuthorizationResult:
        level = agent_levels.get(ctx.agent)
        if level is None:
            return AuthorizationResult(
                allowed=False,
                reason=f'Agent "{ctx.agent}" has no assigned autonomy level',
                layer="permissions",
            )

        level_def = next(
            (lv for lv in policy.spec.levels if lv.level == level), None
        )
        if level_def is None:
            return AuthorizationResult(
                allowed=False,
                reason=f"Autonomy level {level} not defined in policy",
                layer="permissions",
            )

        constraints = agent_constraints.get(ctx.agent)
        return authorize(level_def.permissions, constraints, ctx.action, ctx.target)

    return hook
