"""Smoke test — verifies the package is importable."""

import json
from pathlib import Path

import ai_sdlc


def test_version() -> None:
    manifest = Path(__file__).resolve().parents[2] / ".release-please-manifest.json"
    expected = json.loads(manifest.read_text())["sdk-python"]
    assert ai_sdlc.__version__ == expected
