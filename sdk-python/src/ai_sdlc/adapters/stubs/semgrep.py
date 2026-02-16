"""Stub Semgrep adapter for testing."""

from __future__ import annotations

from dataclasses import dataclass, field

from ai_sdlc.adapters.interfaces import (
    Finding,
    ScanInput,
    ScanResult,
    SeveritySummary,
)


@dataclass
class StubSemgrepConfig:
    preloaded_findings: list[Finding] = field(default_factory=list)
    supported_rulesets: list[str] = field(default_factory=list)


class StubSemgrepAdapter:
    def __init__(self, config: StubSemgrepConfig | None = None) -> None:
        self._config = config or StubSemgrepConfig()
        self._scans: dict[str, list[Finding]] = {}
        self._next_id = 1

    async def run_scan(self, input: ScanInput) -> ScanResult:
        sid = f"sg-scan-{self._next_id}"
        self._next_id += 1
        findings = [
            Finding(
                id=f.id, severity=f.severity, message=f.message,
                file=f.file, rule=f.rule, line=f.line,
            )
            for f in self._config.preloaded_findings
        ]
        # Filter by rulesets if scan specifies them
        if (
            input.rulesets
            and self._config.supported_rulesets
        ):
            matched = [
                r for r in input.rulesets
                if r in self._config.supported_rulesets
            ]
            if not matched:
                findings = []
        self._scans[sid] = findings
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

    def get_supported_rulesets(self) -> list[str]:
        return list(self._config.supported_rulesets)

    def get_scan_count(self) -> int:
        return len(self._scans)


def create_stub_semgrep(
    config: StubSemgrepConfig | None = None,
) -> StubSemgrepAdapter:
    return StubSemgrepAdapter(config)
