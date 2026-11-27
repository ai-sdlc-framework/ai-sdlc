"""Embedded schemas must equal spec/schemas (AISDLC-1302, AISDLC-1308)."""

import json
from pathlib import Path

import pytest

from ai_sdlc.core._generated_schemas import SCHEMAS

SPEC = Path(__file__).resolve().parents[3] / "spec" / "schemas"
NAMES = [
    "adapter-binding",
    "agent-role",
    "autonomy-policy",
    "capabilities-config.v1",
    "common",
    "compliance-posture.v1",
    "design-intent-document",
    "design-system-binding",
    "dor-config.v1",
    "journey.v1",
    "judgment-config.v1",
    "pipeline",
    "quality-gate",
]


@pytest.mark.parametrize("name", NAMES)
def test_schema_matches_spec(name: str) -> None:
    f = f"{name}.schema.json"
    assert SCHEMAS[f] == json.loads((SPEC / f).read_text())


def test_every_embedded_schema_is_checked() -> None:
    assert set(SCHEMAS) == {f"{n}.schema.json" for n in NAMES}
