"""Composed admission pipeline (PRD Section 10).

Chains authentication, authorization, mutating gates, and enforcement
into a single pipeline with short-circuit on failure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ai_sdlc.policy.enforcement import EnforcementResult, EvaluationContext, enforce
from ai_sdlc.policy.mutating_gate import MutatingGateContext, apply_mutating_gates

if TYPE_CHECKING:
    from ai_sdlc.core.types import AnyResource, QualityGate
    from ai_sdlc.policy.authentication import Authenticator, AuthIdentity
    from ai_sdlc.policy.authorization import AuthorizationHook, AuthorizationResult
    from ai_sdlc.policy.mutating_gate import MutatingGate


@dataclass
class AdmissionRequest:
    resource: AnyResource
    token: str | None = None
    action: str | None = None
    target: str | None = None
    override_role: str | None = None
    override_justification: str | None = None


@dataclass
class AdmissionPipeline:
    quality_gate: QualityGate
    evaluation_context: dict[str, object] = field(default_factory=dict)
    authenticator: Authenticator | None = None
    authorizer: AuthorizationHook | None = None
    mutating_gates: list[MutatingGate] | None = None


@dataclass(frozen=True)
class AdmissionResult:
    admitted: bool
    resource: AnyResource
    identity: AuthIdentity | None = None
    authz_result: AuthorizationResult | None = None
    gate_result: EnforcementResult | None = None
    error: str | None = None


async def admit_resource(
    request: AdmissionRequest,
    pipeline: AdmissionPipeline,
) -> AdmissionResult:
    """Run the full admission pipeline: authenticate -> authorize -> mutate -> enforce.

    Short-circuits on failure at any stage.
    """
    resource = request.resource
    identity = None

    # Stage 1: Authenticate (optional)
    if pipeline.authenticator is not None:
        if not request.token:
            return AdmissionResult(
                admitted=False,
                resource=resource,
                error="Authentication required but no token provided",
            )
        auth_result = await pipeline.authenticator.authenticate(request.token)
        if not auth_result.success:
            return AdmissionResult(
                admitted=False,
                resource=resource,
                error=f"Authentication failed: {auth_result.reason or 'unknown'}",
            )
        identity = auth_result.identity

    # Stage 2: Authorize (optional)
    authz_result = None
    if pipeline.authorizer is not None:
        from ai_sdlc.policy.authorization import AuthorizationContext

        agent = identity.actor if identity else "anonymous"
        action = request.action or "write"
        # Normalize action to valid literal
        if action not in ("read", "write", "execute"):
            action = "write"
        authz_result = pipeline.authorizer(
            AuthorizationContext(
                agent=agent,
                action=action,  # type: ignore[arg-type]
                target=request.target or resource.metadata.name,
            )
        )
        if not authz_result.allowed:
            return AdmissionResult(
                admitted=False,
                resource=resource,
                identity=identity,
                authz_result=authz_result,
                error=f"Authorization denied: {authz_result.reason or 'unknown'}",
            )

    # Stage 3: Mutate (optional)
    if pipeline.mutating_gates and len(pipeline.mutating_gates) > 0:
        ctx = MutatingGateContext(
            author_type=identity.actor_type if identity else "ai-agent",
        )
        resource = apply_mutating_gates(resource, pipeline.mutating_gates, ctx)

    # Stage 4: Enforce (required)
    eval_ctx_kwargs: dict[str, Any] = {
        "author_type": (identity.actor_type if identity else "ai-agent"),
        "repository": "",
        "metrics": {},
    }
    # Merge pipeline.evaluation_context
    for k, v in pipeline.evaluation_context.items():
        eval_ctx_kwargs[k] = v
    # Override from request
    if request.override_role is not None:
        eval_ctx_kwargs["override_role"] = request.override_role
    if request.override_justification is not None:
        eval_ctx_kwargs["override_justification"] = request.override_justification

    eval_ctx = EvaluationContext(**eval_ctx_kwargs)
    gate_result = enforce(pipeline.quality_gate, eval_ctx)

    return AdmissionResult(
        admitted=gate_result.allowed,
        resource=resource,
        identity=identity,
        authz_result=authz_result,
        gate_result=gate_result,
    )
