"""Tests for authorization enforcement."""

from ai_sdlc.core.types import (
    AgentConstraints,
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    DemotionTrigger,
    Guardrails,
    Metadata,
    Permissions,
)
from ai_sdlc.policy.authorization import (
    AuthorizationContext,
    authorize,
    check_constraints,
    check_permission,
    create_authorization_hook,
)


def test_check_permission_allowed() -> None:
    perms = Permissions(read=["**"], write=["src/**"], execute=[])
    result = check_permission(perms, "read", "src/main.py")
    assert result.allowed is True


def test_check_permission_denied() -> None:
    perms = Permissions(read=["src/**"], write=[], execute=[])
    result = check_permission(perms, "read", "config/secret.yaml")
    assert result.allowed is False
    assert result.layer == "permissions"


def test_check_permission_no_patterns() -> None:
    perms = Permissions(read=[], write=[], execute=[])
    result = check_permission(perms, "write", "src/main.py")
    assert result.allowed is False


def test_check_constraints_blocked_path() -> None:
    constraints = AgentConstraints(
        blocked_paths=["secrets/**", ".env"],
        allowed_languages=None,
    )
    result = check_constraints(constraints, "secrets/db.key")
    assert result.allowed is False
    assert result.layer == "constraints"


def test_check_constraints_allowed_languages() -> None:
    constraints = AgentConstraints(
        blocked_paths=None,
        allowed_languages=["python", "typescript"],
    )
    result = check_constraints(constraints, "src/main.py")
    assert result.allowed is True
    result2 = check_constraints(constraints, "src/main.rs")
    assert result2.allowed is False


def test_authorize_composite() -> None:
    perms = Permissions(read=["**"], write=["src/**"], execute=[])
    constraints = AgentConstraints(
        blocked_paths=["src/secrets/**"],
        allowed_languages=None,
    )
    assert authorize(perms, constraints, "write", "src/main.py").allowed is True
    assert authorize(perms, constraints, "write", "src/secrets/key.py").allowed is False


def test_constraints_only_checked_for_write() -> None:
    perms = Permissions(read=["**"], write=["**"], execute=["**"])
    constraints = AgentConstraints(
        blocked_paths=["src/secrets/**"],
        allowed_languages=None,
    )
    # Read should pass even for blocked paths
    assert authorize(perms, constraints, "read", "src/secrets/key.py").allowed is True


def test_create_authorization_hook() -> None:
    policy = AutonomyPolicy(
        metadata=Metadata(name="test", namespace="default"),
        spec=AutonomyPolicySpec(
            levels=[
                AutonomyLevel(
                    level=0,
                    name="supervised",
                    permissions=Permissions(read=["**"], write=[], execute=[]),
                    guardrails=Guardrails(require_approval="all"),
                    monitoring="continuous",
                ),
                AutonomyLevel(
                    level=1,
                    name="assisted",
                    permissions=Permissions(read=["**"], write=["src/**"], execute=[]),
                    guardrails=Guardrails(require_approval="none"),
                    monitoring="real-time-notification",
                ),
            ],
            promotion_criteria={},
            demotion_triggers=[
                DemotionTrigger(
                    trigger="security-violation",
                    action="demote-to-0",
                    cooldown="1h",
                ),
            ],
        ),
    )
    hook = create_authorization_hook(
        policy,
        agent_levels={"agent-1": 0, "agent-2": 1},
        agent_constraints={},
    )

    # Level 0 can read but not write
    r = hook(AuthorizationContext(agent="agent-1", action="read", target="src/main.py"))
    assert r.allowed is True
    r2 = hook(AuthorizationContext(agent="agent-1", action="write", target="src/main.py"))
    assert r2.allowed is False

    # Level 1 can write to src/**
    r3 = hook(AuthorizationContext(agent="agent-2", action="write", target="src/main.py"))
    assert r3.allowed is True

    # Unknown agent
    r4 = hook(AuthorizationContext(agent="unknown", action="read", target="anything"))
    assert r4.allowed is False
