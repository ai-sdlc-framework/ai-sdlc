"""Compliance coverage checker."""

from __future__ import annotations

from dataclasses import dataclass, field

from .mappings import (
    AI_SDLC_CONTROLS,
    REGULATORY_FRAMEWORKS,
    ControlMapping,
    RegulatoryFramework,
    get_mappings_for_framework,
)


@dataclass
class ComplianceCoverageReport:
    framework: RegulatoryFramework
    total_controls: int
    covered_controls: int
    gaps: list[ControlMapping] = field(default_factory=list)
    coverage_percent: float = 0.0


def check_compliance(
    enabled_controls: set[str],
    framework: RegulatoryFramework,
) -> ComplianceCoverageReport:
    """Check compliance coverage for a specific regulatory framework."""
    mappings = get_mappings_for_framework(framework)
    gaps: list[ControlMapping] = []

    for mapping in mappings:
        if mapping.control_id not in enabled_controls:
            gaps.append(mapping)

    total = len(mappings)
    covered = total - len(gaps)
    pct = 100.0 if total == 0 else (covered / total) * 100

    return ComplianceCoverageReport(
        framework=framework,
        total_controls=total,
        covered_controls=covered,
        gaps=gaps,
        coverage_percent=pct,
    )


def check_all_frameworks(
    enabled_controls: set[str],
) -> list[ComplianceCoverageReport]:
    """Check compliance coverage across all regulatory frameworks."""
    return [check_compliance(enabled_controls, fw) for fw in REGULATORY_FRAMEWORKS]


def get_all_control_ids() -> set[str]:
    """Get all available control IDs."""
    return {c.id for c in AI_SDLC_CONTROLS}
