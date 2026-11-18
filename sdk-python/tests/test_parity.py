"""Parity of SDK names with the reference manifest (AISDLC-1305)."""

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PARITY = ROOT.parent / "conformance" / "parity"
SRC = ROOT / "src" / "ai_sdlc"

SECTION_FILES = {
    "resourceKinds": "core/types.py",
    "standardMetrics": "metrics/types.py",
    "spanNames": "telemetry/semantic_conventions.py",
    "metricNames": "telemetry/semantic_conventions.py",
    "attributeKeys": "telemetry/semantic_conventions.py",
    "complianceControls": "compliance/mappings.py",
    "regulatoryFrameworks": "compliance/mappings.py",
}

MANIFEST = json.loads((PARITY / "manifest.json").read_text())
EXEMPT = json.loads((PARITY / "exemptions.json").read_text()).get("python", {})


def defined(section: str, name: str) -> bool:
    text = (SRC / SECTION_FILES[section]).read_text()
    return json.dumps(name) in text


def test_sections_match_manifest() -> None:
    assert set(SECTION_FILES) == set(MANIFEST)
    assert set(EXEMPT) <= set(MANIFEST)


@pytest.mark.parametrize("section,name", [(s, n) for s, names in MANIFEST.items() for n in names])
def test_name_is_defined_or_exempt(section: str, name: str) -> None:
    if name in EXEMPT.get(section, []):
        assert not defined(section, name), (
            f"{section}/{name} is defined; remove it from exemptions.json"
        )
    else:
        assert defined(section, name), f"{section}/{name} is neither defined in the SDK nor exempt"


def test_exemptions_name_manifest_entries() -> None:
    for section, names in EXEMPT.items():
        for name in names:
            assert name in MANIFEST[section], f"stale exemption {section}/{name}"
