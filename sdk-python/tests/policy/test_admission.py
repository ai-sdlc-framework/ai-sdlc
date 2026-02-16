"""Tests for admission pipeline."""

import pytest

from ai_sdlc.core.types import (
    Gate,
    Metadata,
    MetricRule,
    QualityGate,
    QualityGateSpec,
)
from ai_sdlc.policy.admission import (
    AdmissionPipeline,
    AdmissionRequest,
    admit_resource,
)
from ai_sdlc.policy.authentication import AuthIdentity, create_token_authenticator
from ai_sdlc.policy.authorization import AuthorizationContext, AuthorizationResult
from ai_sdlc.policy.mutating_gate import create_label_injector


def _qg() -> QualityGate:
    return QualityGate(
        metadata=Metadata(name="test-qg", namespace="default"),
        spec=QualityGateSpec(
            gates=[
                Gate(
                    name="cov",
                    enforcement="hard-mandatory",
                    rule=MetricRule(metric="coverage", operator=">=", threshold=80),
                ),
            ],
        ),
    )


def _resource() -> QualityGate:
    """Use a QualityGate as the admitted resource (any resource type works)."""
    return _qg()


@pytest.mark.asyncio
async def test_admit_without_auth() -> None:
    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 90}},
    )
    result = await admit_resource(
        AdmissionRequest(resource=_resource()),
        pipeline,
    )
    assert result.admitted is True


@pytest.mark.asyncio
async def test_admit_fails_gate() -> None:
    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 70}},
    )
    result = await admit_resource(
        AdmissionRequest(resource=_resource()),
        pipeline,
    )
    assert result.admitted is False


@pytest.mark.asyncio
async def test_admit_with_authentication() -> None:
    identity = AuthIdentity(actor="agent-1", actor_type="ai-agent")
    auth = create_token_authenticator({"good-token": identity})

    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 90}},
        authenticator=auth,
    )

    # Good token
    result = await admit_resource(
        AdmissionRequest(resource=_resource(), token="good-token"),
        pipeline,
    )
    assert result.admitted is True
    assert result.identity is not None
    assert result.identity.actor == "agent-1"

    # Bad token
    result2 = await admit_resource(
        AdmissionRequest(resource=_resource(), token="bad-token"),
        pipeline,
    )
    assert result2.admitted is False
    assert "Authentication failed" in (result2.error or "")


@pytest.mark.asyncio
async def test_admit_auth_no_token() -> None:
    identity = AuthIdentity(actor="agent-1", actor_type="ai-agent")
    auth = create_token_authenticator({"good-token": identity})

    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 90}},
        authenticator=auth,
    )
    result = await admit_resource(
        AdmissionRequest(resource=_resource()),
        pipeline,
    )
    assert result.admitted is False
    assert "no token" in (result.error or "")


@pytest.mark.asyncio
async def test_admit_with_authorizer() -> None:
    def deny_all(ctx: AuthorizationContext) -> AuthorizationResult:
        return AuthorizationResult(allowed=False, reason="denied")

    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 90}},
        authorizer=deny_all,
    )
    result = await admit_resource(
        AdmissionRequest(resource=_resource()),
        pipeline,
    )
    assert result.admitted is False
    assert "Authorization denied" in (result.error or "")


@pytest.mark.asyncio
async def test_admit_with_mutating_gates() -> None:
    pipeline = AdmissionPipeline(
        quality_gate=_qg(),
        evaluation_context={"metrics": {"coverage": 90}},
        mutating_gates=[create_label_injector({"env": "prod"})],
    )
    result = await admit_resource(
        AdmissionRequest(resource=_resource()),
        pipeline,
    )
    assert result.admitted is True
    assert result.resource.metadata.labels["env"] == "prod"
