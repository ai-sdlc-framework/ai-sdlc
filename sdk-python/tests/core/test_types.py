"""Tests for core Pydantic models."""

from ai_sdlc.core.types import (
    API_VERSION,
    AdapterBinding,
    AdapterBindingSpec,
    AgentRole,
    AgentRoleSpec,
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    DemotionTrigger,
    Gate,
    Guardrails,
    Metadata,
    MetricRule,
    Permissions,
    Pipeline,
    PipelineSpec,
    PromotionCriteria,
    Provider,
    QualityGate,
    QualityGateSpec,
    Stage,
    Trigger,
)


def test_api_version() -> None:
    assert API_VERSION == "ai-sdlc.io/v1alpha1"


def test_pipeline_minimal() -> None:
    p = Pipeline(
        metadata=Metadata(name="test"),
        spec=PipelineSpec(
            triggers=[Trigger(event="issue.assigned")],
            providers={"gh": Provider(type="github")},
            stages=[Stage(name="implement")],
        ),
    )
    assert p.kind == "Pipeline"
    assert p.api_version == API_VERSION
    d = p.model_dump(by_alias=True)
    assert d["apiVersion"] == API_VERSION
    assert d["spec"]["stages"][0]["name"] == "implement"


def test_pipeline_from_camel_case() -> None:
    data = {
        "apiVersion": "ai-sdlc.io/v1alpha1",
        "kind": "Pipeline",
        "metadata": {"name": "test"},
        "spec": {
            "triggers": [{"event": "push"}],
            "providers": {"ci": {"type": "github-actions"}},
            "stages": [
                {
                    "name": "build",
                    "qualityGates": ["gate1"],
                    "onFailure": {"strategy": "retry", "maxRetries": 3},
                }
            ],
        },
    }
    p = Pipeline.model_validate(data)
    assert p.spec.stages[0].quality_gates == ["gate1"]
    assert p.spec.stages[0].on_failure is not None
    assert p.spec.stages[0].on_failure.max_retries == 3


def test_agent_role() -> None:
    ar = AgentRole(
        metadata=Metadata(name="coder"),
        spec=AgentRoleSpec(role="engineer", goal="write code", tools=["editor"]),
    )
    assert ar.kind == "AgentRole"
    d = ar.model_dump(by_alias=True)
    assert d["spec"]["tools"] == ["editor"]


def test_quality_gate() -> None:
    qg = QualityGate(
        metadata=Metadata(name="coverage"),
        spec=QualityGateSpec(
            gates=[
                Gate(
                    name="cov",
                    enforcement="hard-mandatory",
                    rule=MetricRule(metric="coverage", operator=">=", threshold=80),
                )
            ]
        ),
    )
    assert qg.kind == "QualityGate"


def test_autonomy_policy() -> None:
    ap = AutonomyPolicy(
        metadata=Metadata(name="standard"),
        spec=AutonomyPolicySpec(
            levels=[
                AutonomyLevel(
                    level=0,
                    name="Supervised",
                    permissions=Permissions(read=["*"], write=[], execute=[]),
                    guardrails=Guardrails(requireApproval="all"),
                    monitoring="continuous",
                )
            ],
            promotionCriteria={
                "0-to-1": PromotionCriteria(
                    minimumTasks=10,
                    conditions=[],
                    requiredApprovals=["lead"],
                )
            },
            demotionTriggers=[
                DemotionTrigger(
                    trigger="security-violation",
                    action="demote-to-0",
                    cooldown="7d",
                )
            ],
        ),
    )
    assert ap.kind == "AutonomyPolicy"
    assert ap.spec.levels[0].guardrails.require_approval == "all"


def test_adapter_binding() -> None:
    ab = AdapterBinding(
        metadata=Metadata(name="github-adapter"),
        spec=AdapterBindingSpec(
            **{"interface": "SourceControl"},
            type="github",
            version="1.0.0",
        ),
    )
    assert ab.kind == "AdapterBinding"
    d = ab.model_dump(by_alias=True)
    assert d["spec"]["interface"] == "SourceControl"
