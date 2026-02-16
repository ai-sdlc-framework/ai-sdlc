"""Tests for ABAC authorization."""

from ai_sdlc.policy.abac import ABACPolicy, create_abac_authorization_hook
from ai_sdlc.policy.authorization import AuthorizationContext
from ai_sdlc.policy.expression import create_simple_expression_evaluator


def test_abac_allow() -> None:
    evaluator = create_simple_expression_evaluator()
    policies = [
        ABACPolicy(
            name="allow-reads",
            expression="action == 'read'",
            effect="allow",
        ),
    ]
    hook = create_abac_authorization_hook(evaluator, policies)
    result = hook(AuthorizationContext(agent="agent-1", action="read", target="src/main.py"))
    assert result.allowed is True


def test_abac_deny() -> None:
    evaluator = create_simple_expression_evaluator()
    policies = [
        ABACPolicy(
            name="deny-secrets",
            expression="resource.name == 'secrets/db.key'",
            effect="deny",
        ),
        ABACPolicy(
            name="allow-all",
            expression="true",
            effect="allow",
        ),
    ]
    hook = create_abac_authorization_hook(evaluator, policies)
    result = hook(AuthorizationContext(agent="agent-1", action="write", target="secrets/db.key"))
    assert result.allowed is False
    assert "Denied by ABAC" in (result.reason or "")


def test_abac_deny_takes_precedence() -> None:
    evaluator = create_simple_expression_evaluator()
    policies = [
        ABACPolicy(name="allow-all", expression="true", effect="allow"),
        ABACPolicy(name="deny-all", expression="true", effect="deny"),
    ]
    hook = create_abac_authorization_hook(evaluator, policies)
    result = hook(AuthorizationContext(agent="a", action="read", target="t"))
    # deny should match first in order — but actually allow matches first,
    # then deny matches and short-circuits
    assert result.allowed is False


def test_abac_default_deny() -> None:
    evaluator = create_simple_expression_evaluator()
    policies = [
        ABACPolicy(
            name="allow-admin",
            expression="subject.name == 'admin'",
            effect="allow",
        ),
    ]
    hook = create_abac_authorization_hook(evaluator, policies)
    result = hook(AuthorizationContext(agent="agent-1", action="read", target="t"))
    assert result.allowed is False
    assert "No ABAC policy matched" in (result.reason or "")


def test_abac_custom_context_provider() -> None:
    evaluator = create_simple_expression_evaluator()
    policies = [
        ABACPolicy(
            name="allow-team-alpha",
            expression="team == 'alpha'",
            effect="allow",
        ),
    ]

    def provider(ctx: AuthorizationContext) -> dict:
        return {
            "subject": {"name": ctx.agent},
            "resource": {"name": ctx.target},
            "action": ctx.action,
            "team": "alpha",
        }

    hook = create_abac_authorization_hook(evaluator, policies, context_provider=provider)
    result = hook(AuthorizationContext(agent="agent-1", action="read", target="t"))
    assert result.allowed is True
