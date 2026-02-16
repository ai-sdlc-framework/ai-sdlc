"""Stub CodeAnalysis adapter for testing."""

from __future__ import annotations

from dataclasses import dataclass, field

from ai_sdlc.adapters.interfaces import (
    Finding,
    ScanInput,
    ScanResult,
    SeveritySummary,
)


@dataclass
class StubCodeAnalysisConfig:
    preloaded_findings: list[Finding] = field(default_factory=list)


class StubCodeAnalysisAdapter:
    def __init__(self, config: StubCodeAnalysisConfig | None = None) -> None:
        self._config = config or StubCodeAnalysisConfig()
        self._scans: dict[str, list[Finding]] = {}
        self._next_id = 1

    async def run_scan(self, input: ScanInput) -> ScanResult:
        sid = f"ca-scan-{self._next_id}"
        self._next_id += 1
        self._scans[sid] = [
            Finding(
                id=f.id, severity=f.severity, message=f.message,
                file=f.file, rule=f.rule, line=f.line,
            )
            for f in self._config.preloaded_findings
        ]
        return ScanResult(id=sid, status="completed")

    async def get_findings(self, scan_id: str) -> list[Finding]:
        if scan_id not in self._scans:
            raise KeyError(f'Scan "{scan_id}" not found')
        return self._scans[scan_id]

    async def get_severity_summary(self, scan_id: str) -> SeveritySummary:
        findings = await self.get_findings(scan_id)
        counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        for f in findings:
            counts[f.severity] += 1
        return SeveritySummary(**counts)

    def get_scan_count(self) -> int:
        return len(self._scans)


def create_stub_code_analysis(
    config: StubCodeAnalysisConfig | None = None,
) -> StubCodeAnalysisAdapter:
    return StubCodeAnalysisAdapter(config)
