"""Parity of SDK names with the reference manifest (AISDLC-1305)."""

import json
import re
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


def _literals(block: str) -> set[str]:
    return set(re.findall(r'"([^"]+)"', block))


def _class_body(text: str, cls: str) -> str:
    m = re.search(rf"class {cls}:.*?(?=\n\n\n|\Z)", text, re.S)
    assert m, f"{cls} not found"
    return m.group(0)


def _list_literal(text: str, opener: str) -> str:
    m = re.search(rf"{re.escape(opener)}.*?\n\]", text, re.S)
    assert m, f"{opener} not found"
    return m.group(0)


EXTRACTORS = {
    "resourceKinds": lambda t: _literals(_list_literal(t, "ResourceKind = Literal[")),
    "standardMetrics": lambda t: set(re.findall(r'_md\(\s*"([^"]+)"', t)),
    "spanNames": lambda t: _literals(_class_body(t, "_SpanNames")),
    "metricNames": lambda t: _literals(_class_body(t, "_MetricNames")),
    "attributeKeys": lambda t: _literals(_class_body(t, "_AttributeKeys")),
    "complianceControls": lambda t: set(re.findall(r'ComplianceControl\(\s*"([^"]+)"', t)),
    "regulatoryFrameworks": lambda t: _literals(_list_literal(t, "REGULATORY_FRAMEWORKS:")),
}


def sdk_defined(section: str, text: str) -> set[str]:
    """The names the SDK source `text` defines for a manifest section."""
    return EXTRACTORS[section](text)


@pytest.mark.parametrize("section", list(SECTION_FILES))
def test_sdk_defines_no_name_absent_from_manifest(section: str) -> None:
    text = (SRC / SECTION_FILES[section]).read_text()
    extra = sdk_defined(section, text) - set(MANIFEST[section])
    assert not extra, f"{section}: SDK defines names the reference lacks: {sorted(extra)}"


def test_extractors_cover_every_manifest_name() -> None:
    for section, names in MANIFEST.items():
        text = (SRC / SECTION_FILES[section]).read_text()
        missing = set(names) - sdk_defined(section, text) - set(EXEMPT.get(section, []))
        assert not missing, f"{section}: extractor misses {sorted(missing)}"


@pytest.mark.parametrize(
    "section,anchor,added",
    [
        ("resourceKinds", '    "AdapterBinding",\n]', '    "AdapterBinding",\n    "Bogus",\n]'),
        (
            "standardMetrics",
            '_md(\n        "approval-rate"',
            '_md(\n        "bogus-metric", "code-quality", "d", "u"),\n    _md(\n        "approval-rate"',  # noqa: E501
        ),
        (
            "spanNames",
            'HANDOFF: str = "ai_sdlc.handoff"',
            'BOGUS: str = "ai_sdlc.bogus"\n    HANDOFF: str = "ai_sdlc.handoff"',
        ),
        (
            "metricNames",
            "TOKENS_TOTAL: str",
            'BOGUS: str = "ai_sdlc.bogus.total"\n    TOKENS_TOTAL: str',
        ),
        ("attributeKeys", "RUN_ID: str", 'BOGUS: str = "ai_sdlc.bogus"\n    RUN_ID: str'),
        (
            "complianceControls",
            'ComplianceControl(\n        "quality-gates"',
            'ComplianceControl(\n        "bogus-control", "B", "d"),\n    ComplianceControl(\n        "quality-gates"',  # noqa: E501
        ),
        ("regulatoryFrameworks", '"csa-atf",\n]', '"csa-atf", "bogus-framework",\n]'),
    ],
)
def test_patched_sdk_only_name_is_detected(section: str, anchor: str, added: str) -> None:
    text = (SRC / SECTION_FILES[section]).read_text()
    assert anchor in text, f"anchor for {section} not found"
    patched = text.replace(anchor, added, 1)
    extra = sdk_defined(section, patched) - set(MANIFEST[section])
    assert len(extra) == 1, f"{section}: expected one SDK-only name, got {sorted(extra)}"
