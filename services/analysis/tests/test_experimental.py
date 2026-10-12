import base64
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from senmiva_analysis.api.app import create_app
from senmiva_analysis.api.boundary import PrivateAnalysisBoundary
from senmiva_analysis.application.ports import ImageRejectedError, ProviderUnavailableError
from senmiva_analysis.domain.models import IngredientCandidate, IngredientOutput, ModelProbability, VisualHead, VisualOutput
from senmiva_analysis.settings import Settings


KEY = "test-secret-only-32-characters-or-longer"
HEADERS = {"X-Analysis-Key": KEY}
REQUEST_ID = "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b"


class SyntheticProvider:
    model_version = "synthetic-visual+synthetic-ingredients"
    disclaimer = "Experimental synthetic fixture only."
    def __init__(self):
        self.calls = []
        self.failure = None
    def analyze(self, profile, image):
        self.calls.append((profile, image))
        if self.failure:
            raise self.failure
        visual = None if image is None else VisualOutput("synthetic-visual:best:epoch-1", tuple(
            VisualHead(key, key.title(), "A", (ModelProbability("A", .75), ModelProbability("B", .25)))
            for key in ("sensitivity", "pigmentation", "wrinkles", "acne", "pores", "sagging", "keratin", "redness")))
        ingredients = IngredientOutput("synthetic-ingredients:best:epoch-1", (IngredientCandidate("Panthenol", .75),), ("partial_questionnaire_features",))
        return visual, ingredients


@pytest.fixture
def setup():
    provider = SyntheticProvider()
    with TestClient(create_app(Settings(api_key=KEY, provider="experimental", ml_workspace=Path("unused")), experimental_provider=provider)) as client:
        yield client, provider


@pytest.fixture
def payload():
    return {"request_id": REQUEST_ID, "concern_ids": ["texture"], "skin_type": "dry", "sensitive": True}


def test_health_mode_is_explicit_and_legacy_mock_cannot_fallback(setup, payload):
    client, provider = setup
    assert client.get("/healthz").json() == {"status": "ok", "mode": "experimental"}
    assert client.post("/v1/analyze", json=payload, headers=HEADERS).status_code == 503
    assert not provider.calls


def test_mock_configuration_cannot_serve_experimental(payload):
    with TestClient(create_app(Settings(api_key=KEY))) as client:
        assert client.post("/v1/analyze/experimental", json=payload, headers=HEADERS).status_code == 503


@pytest.mark.parametrize("photo", [False, True])
def test_typed_ephemeral_inference_contract(setup, payload, photo):
    client, provider = setup
    if photo:
        payload["image_base64"] = base64.b64encode(b"synthetic-image").decode()
    response = client.post("/v1/analyze/experimental", json=payload, headers=HEADERS)
    assert response.status_code == 200
    result = response.json()
    assert UUID(result["request_id"]) == UUID(REQUEST_ID)
    assert result["mode"] == result["quality_status"] == "experimental"
    assert result["observations"] == []
    assert bool(result["visual"]) is photo
    assert result["ingredients"]["candidates"] == [{"ingredient": "Panthenol", "score": .75}]
    assert provider.calls[0][1] == (b"synthetic-image" if photo else None)
    assert "synthetic-image" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("image", ["%%%%", "data:image/png;base64,YQ==", "YQ", "éééé"])
def test_invalid_base64_is_private_and_does_not_call_provider(setup, payload, image):
    client, provider = setup
    payload["image_base64"] = image
    response = client.post("/v1/analyze/experimental", json=payload, headers=HEADERS)
    assert response.status_code == 422
    assert image not in response.text
    assert not provider.calls


@pytest.mark.parametrize("error,status", [(ImageRejectedError("private-photo-details"), 422), (ProviderUnavailableError("private-model-path"), 503), (RuntimeError("private-body"), 503)])
def test_provider_errors_are_private_and_fail_closed(setup, payload, error, status):
    client, provider = setup
    provider.failure = error
    response = client.post("/v1/analyze/experimental", json=payload, headers=HEADERS)
    assert response.status_code == status and "private" not in response.text


def test_image_bounds_auth_before_body_and_unknown_field_rejection(setup, payload):
    client, provider = setup
    response = client.post("/v1/analyze/experimental", content="private-invalid", headers={"Content-Type": "application/json"})
    assert response.status_code == 401
    payload["organization_id"] = "private-tenant"
    response = client.post("/v1/analyze/experimental", json=payload, headers=HEADERS)
    assert response.status_code == 422 and "private-tenant" not in response.text
    assert not provider.calls
    response = client.post("/v1/analyze/experimental", content=b"a", headers={**HEADERS, "Content-Type": "application/json", "Content-Length": str(PrivateAnalysisBoundary.EXPERIMENTAL_MAX_BODY_BYTES + 1)})
    assert response.status_code == 413


def test_experimental_chunked_bodies_are_bounded(setup):
    client, provider = setup
    def chunks():
        yield b"x" * 8_000_000
        yield b"x" * (PrivateAnalysisBoundary.EXPERIMENTAL_MAX_BODY_BYTES - 8_000_000 + 1)
    response = client.post("/v1/analyze/experimental", content=chunks(), headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 413 and not provider.calls


def test_single_inference_admission_is_before_second_body_and_released(setup, payload, monkeypatch):
    client, provider = setup
    entered, release = threading.Event(), threading.Event()
    original = provider.analyze
    def blocking(profile, image):
        entered.set()
        assert release.wait(5)
        return original(profile, image)
    monkeypatch.setattr(provider, "analyze", blocking)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/v1/analyze/experimental", json=payload, headers=HEADERS)
        assert entered.wait(5)
        try:
            second = client.post("/v1/analyze/experimental", content="private-invalid-body", headers={**HEADERS, "Content-Type": "application/json"})
            assert second.status_code == 429 and "private" not in second.text
        finally:
            release.set()
        assert first.result().status_code == 200
    assert client.post("/v1/analyze/experimental", json=payload, headers=HEADERS).status_code == 200


def test_failed_inference_releases_admission_slot(setup, payload):
    client, provider = setup
    provider.failure = RuntimeError("private-path")
    assert client.post("/v1/analyze/experimental", json=payload, headers=HEADERS).status_code == 503
    provider.failure = None
    assert client.post("/v1/analyze/experimental", json=payload, headers=HEADERS).status_code == 200


def test_invalid_provider_scores_fail_closed_without_details(setup, payload, monkeypatch):
    client, provider = setup
    def invalid(profile, image):
        return None, IngredientOutput("fixture", (IngredientCandidate("private-label", float("nan")),), ("partial",))
    monkeypatch.setattr(provider, "analyze", invalid)
    response = client.post("/v1/analyze/experimental", json=payload, headers=HEADERS)
    assert response.status_code == 503 and "private-label" not in response.text


def test_experimental_workspace_required_and_names_cannot_escape():
    with pytest.raises(ValueError, match="SENMIVA_ML_WORKSPACE"):
        Settings(api_key=KEY, provider="experimental")
    with pytest.raises(ValueError, match="identifiers"):
        Settings(api_key=KEY, photo_run="../secret")
    with pytest.raises(ValueError, match="ANALYSIS_DEVICE"):
        Settings(api_key=KEY, device="other")
