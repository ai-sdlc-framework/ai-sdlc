"""AI-SDLC Python SDK — native implementation of the AI-SDLC Framework."""

__version__ = "0.1.0"

from ai_sdlc.builders.builders import (
    AdapterBindingBuilder,
    AgentRoleBuilder,
    AutonomyPolicyBuilder,
    PipelineBuilder,
    QualityGateBuilder,
)
from ai_sdlc.core.types import (
    API_VERSION,
    AdapterBinding,
    AgentRole,
    AnyResource,
    AutonomyPolicy,
    Pipeline,
    QualityGate,
    ResourceKind,
)
from ai_sdlc.core.validation import validate_resource

__all__ = [
    "__version__",
    "API_VERSION",
    "AdapterBinding",
    "AgentRole",
    "AnyResource",
    "AutonomyPolicy",
    "Pipeline",
    "QualityGate",
    "ResourceKind",
    "validate_resource",
    "AdapterBindingBuilder",
    "AgentRoleBuilder",
    "AutonomyPolicyBuilder",
    "PipelineBuilder",
    "QualityGateBuilder",
]
