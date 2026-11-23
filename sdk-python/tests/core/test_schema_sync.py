"""Embedded schemas must equal spec/schemas (AISDLC-1302)."""

import json
from pathlib import Path

import pytest

from ai_sdlc.core._generated_schemas import SCHEMAS

SPEC = Path(__file__).resolve().parents[3] / "spec" / "schemas"
NAMES = ["adapter-binding", "agent-role", "autonomy-policy", "common", "pipeline", "quality-gate"]


@pytest.mark.parametrize("name", NAMES)
def test_schema_matches_spec(name: str) -> None:
    f = f"{name}.schema.json"
    assert SCHEMAS[f] == json.loads((SPEC / f).read_text())
