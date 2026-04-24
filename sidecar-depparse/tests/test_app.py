"""FastAPI endpoint tests using the TestClient."""

from __future__ import annotations

import pytest


fastapi = pytest.importorskip("fastapi", reason="fastapi not installed")

from fastapi.testclient import TestClient  # noqa: E402

from sidecar_depparse.app import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app())


def test_healthz_returns_200(client: TestClient) -> None:
    """AC #3: Healthz returns 200 with (optional) model version."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "model_loaded" in body


def test_match_endpoint_shape(client: TestClient) -> None:
    # When spaCy model isn't installed in CI, this returns 503; otherwise 200.
    resp = client.post(
        "/v1/match",
        json={"text": "Text here", "patterns": ["requires developer"]},
    )
    assert resp.status_code in {200, 503}
    if resp.status_code == 200:
        body = resp.json()
        assert "matches" in body
        assert isinstance(body["matches"], list)


def test_match_empty_patterns(client: TestClient) -> None:
    resp = client.post("/v1/match", json={"text": "anything", "patterns": []})
    if resp.status_code == 200:
        assert resp.json() == {"matches": []}
