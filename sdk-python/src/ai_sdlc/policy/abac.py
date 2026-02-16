"""Attribute-Based Access Control (ABAC) authorization.

Extends the existing authorization hook with expression-based
policy evaluation using Rego or CEL evaluators.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from ai_sdlc.policy.authorization import (
    AuthorizationContext,
    AuthorizationHook,
    AuthorizationResult,
)

if TYPE_CHECKING:
    from ai_sdlc.policy.expression import ExpressionEvaluator


@dataclass
class ABACPolicy:
    """A single ABAC policy rule."""

    name: str
    expression: str
    effect: Literal["allow", "deny"]


@dataclass
class ABACContext:
    """Rich context for ABAC evaluation."""

    subject: dict[str, Any] = field(default_factory=dict)
    resource: dict[str, Any] = field(default_factory=dict)
    action: str = ""
    environment: dict[str, Any] = field(default_factory=dict)


ABACContextProvider = Callable[[AuthorizationContext], dict[str, Any]]


def _default_context_provider(ctx: AuthorizationContext) -> dict[str, Any]:
    return {
        "subject": {"name": ctx.agent},
        "resource": {"name": ctx.target},
        "action": ctx.action,
        "environment": {},
    }


def create_abac_authorization_hook(
    evaluator: ExpressionEvaluator,
    policies: list[ABACPolicy],
    context_provider: ABACContextProvider | None = None,
) -> AuthorizationHook:
    """Create an ABAC authorization hook.

    Evaluates a set of policies using the provided expression evaluator.
    Policies are evaluated in order. The first matching 'deny' policy
    blocks access. If no 'deny' matches and at least one 'allow' matches,
    access is granted. If no policies match, access is denied by default.
    """
    get_context = context_provider or _default_context_provider

    def hook(ctx: AuthorizationContext) -> AuthorizationResult:
        eval_context = get_context(ctx)
        any_allow = False

        for policy in policies:
            try:
                matches = evaluator.evaluate(policy.expression, eval_context)
                if matches:
                    if policy.effect == "deny":
                        return AuthorizationResult(
                            allowed=False,
                            reason=f'Denied by ABAC policy "{policy.name}"',
                        )
                    if policy.effect == "allow":
                        any_allow = True
            except Exception:
                # Expression evaluation errors are treated as non-matching
                pass

        if any_allow:
            return AuthorizationResult(allowed=True)

        return AuthorizationResult(
            allowed=False,
            reason="No ABAC policy matched — default deny",
        )

    return hook
