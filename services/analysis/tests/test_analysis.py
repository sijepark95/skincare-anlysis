from dataclasses import FrozenInstanceError
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from senmiva_analysis.api.app import create_app
from senmiva_analysis.application.ports import ProviderUnavailableError
from senmiva_analysis.domain.models import ConcernId, SkinProfile, SkinType
from senmiva_analysis.infrastructure.pytorch_provider import PyTorchAnalysisProvider
from senmiva_analysis.settings import Settings

KEY = "test-secret-only-32-characters-or-longer"
HEADERS = {"X-Analysis-Key": KEY}
REQUEST_ID = "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b"


@pytest.fixture
def client():
    with TestClient(create_app(Settings(api_key=KEY))) as test_client:
        yield test_client


@pytest.fixture
def payload():
    return {
        "request_id": REQUEST_ID,
        "concern_ids": ["dehydration", "texture", "uneven_tone", "fine_lines"],
        "skin_type": "dry",
        "sensitive": True,
    }


def test_health_is_public_and_does_not_reveal_secret(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "mock"}
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text


@pytest.mark.parametrize("headers", [{}, {"X-Analysis-Key": "wrong"}])
def test_missing_or_wrong_secret_is_rejected_before_body_validation(client, headers):
    response = client.post("/v1/analyze", content="not json", headers=headers)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


def test_duplicate_credentials_are_rejected(client, payload):
    response = client.post("/v1/analyze", json=payload, headers=[("X-Analysis-Key", KEY), ("X-Analysis-Key", KEY)])
    assert response.status_code == 401


def test_mock_contract_and_determinism(client, payload):
    first = client.post("/v1/analyze", json=payload, headers=HEADERS)
    second = client.post("/v1/analyze", json=payload, headers=HEADERS)
    assert first.status_code == 200
    assert first.json() == second.json()
    result = first.json()
    assert UUID(result["request_id"]) == UUID(REQUEST_ID)
    assert result["mode"] == "mock"
    assert result["quality_status"] == "demo"
    assert result["model_version"] == "mock-1.0"
    assert [item["concern_id"] for item in result["observations"]] == payload["concern_ids"]
    assert result["observations"][0] == {"concern_id": "dehydration", "level": "high", "score": 0.78}
    assert all(0 <= item["score"] <= 1 for item in result["observations"])
    assert "not from a photo" in result["disclaimer"]
    assert "no-store" == first.headers["cache-control"]


@pytest.mark.parametrize("field", ["photo", "image", "image_base64", "organization_id", "unexpected"])
def test_extra_fields_and_photos_are_rejected_without_echoing_input(client, payload, field):
    payload[field] = "SENSITIVE-INPUT-MUST-NOT-BE-ECHOED"
    response = client.post("/v1/analyze", json=payload, headers=HEADERS)
    assert response.status_code == 422
    assert "SENSITIVE-INPUT" not in response.text


@pytest.mark.parametrize("invalid", [[], ["dehydration"] * 5, ["dehydration"] * 2, ["unknown"]])
def test_concern_bounds_and_vocabulary(client, payload, invalid):
    payload["concern_ids"] = invalid
    assert client.post("/v1/analyze", json=payload, headers=HEADERS).status_code == 422


@pytest.mark.parametrize("field,value", [
    ("request_id", "not-a-uuid"), ("skin_type", "unknown"),
    ("sensitive", "true"), ("sensitive", 1),
])
def test_types_and_identifiers_are_validated(client, payload, field, value):
    payload[field] = value
    assert client.post("/v1/analyze", json=payload, headers=HEADERS).status_code == 422


def test_body_size_is_bounded(client):
    response = client.post("/v1/analyze", content=b"x" * 4097, headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 413
    assert "x" * 10 not in response.text


def test_chunked_body_size_is_bounded(client):
    def chunks():
        yield b"x" * 2000
        yield b"x" * 2097
    response = client.post("/v1/analyze", content=chunks(), headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 413


def test_non_json_body_is_rejected(client):
    assert client.post("/v1/analyze", content="text", headers=HEADERS).status_code == 415


def test_malformed_json_is_rejected_without_echo(client):
    response = client.post("/v1/analyze", content='{"SENSITIVE-INPUT"', headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 422
    assert "SENSITIVE-INPUT" not in response.text


def test_browser_cors_is_not_enabled(client):
    response = client.options("/v1/analyze", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("key", ["", "short", "replace-with-a-random-secret-at-least-32-characters"])
def test_missing_or_placeholder_configuration_fails_closed(key):
    with pytest.raises(ValueError, match="ANALYSIS_API_KEY"):
        Settings(api_key=key)


def test_app_refuses_missing_environment_secret(monkeypatch):
    monkeypatch.delenv("ANALYSIS_API_KEY", raising=False)
    with pytest.raises(ValueError, match="ANALYSIS_API_KEY"):
        create_app()


def test_settings_repr_does_not_expose_secret():
    assert KEY not in repr(Settings(api_key=KEY))


def test_pytorch_cannot_silently_use_mock():
    profile = SkinProfile((ConcernId.DEHYDRATION,), SkinType.DRY, False)
    with pytest.raises(ProviderUnavailableError, match="not implemented"):
        PyTorchAnalysisProvider().analyze(profile)
    with pytest.raises(ProviderUnavailableError, match="startup refused"):
        Settings(api_key=KEY, provider="pytorch")
    with pytest.raises(ValueError, match="Unknown providers"):
        Settings(api_key=KEY, provider="typo")


def test_domain_models_are_immutable():
    profile = SkinProfile((ConcernId.DEHYDRATION,), SkinType.DRY, False)
    with pytest.raises(FrozenInstanceError):
        profile.sensitive = True
