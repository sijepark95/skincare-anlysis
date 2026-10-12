import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import threading
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from senmiva_analysis.api.app import create_app
from senmiva_analysis.api.boundary import PrivateAnalysisBoundary
from senmiva_analysis.domain.color import ColorObservation, MODEL, PROMPT_VERSION
from senmiva_analysis.infrastructure.color_protocol import ENDPOINT, OpenAIColorProvider, extract_observation
from senmiva_analysis.application.ports import ProviderUnavailableError
from senmiva_analysis.settings import Settings

KEY = "test-secret-only-32-characters-or-longer"
OPENAI_KEY = "sk-synthetic-private-key-for-color-mocked-api-only"
REQUEST_ID = "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b"
HEADERS = {"X-Analysis-Key": KEY}


def photo(size=(640, 480), format="PNG", metadata=False):
    output = BytesIO()
    options = {}
    if metadata:
        info = PngImagePlugin.PngInfo()
        info.add_text("original-name", "PRIVATE-PHOTO-METADATA")
        options["pnginfo"] = info
    Image.new("RGB", size, (140, 110, 90)).save(output, format=format, **options)
    return output.getvalue()


def observation():
    return {"image_quality": "usable", "undertone": "warm", "chroma": "soft", "quality_flags": []}


def envelope(value=None):
    return {"model": MODEL, "status": "completed", "error": None, "incomplete_details": None,
            "output": [{"type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": json.dumps(value or observation()), "annotations": []}]}]}


class FakeResponse:
    status = 200
    def __init__(self, value):
        self.body = json.dumps(value).encode()
        self.headers = {"Content-Type": "application/json", "Content-Length": str(len(self.body))}
        self.offset = 0
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def geturl(self): return ENDPOINT
    def read1(self, size):
        part = self.body[self.offset:self.offset + size]
        self.offset += len(part)
        return part


class UnusedSkinProvider:
    def analyze(self, image): raise AssertionError("Skin protocol must not handle colour requests")


@pytest.fixture
def setup(monkeypatch):
    calls = []
    responses = [envelope()]
    def transport(request, timeout):
        calls.append(request)
        assert 0 < timeout <= 30
        if isinstance(responses[0], Exception): raise responses[0]
        return FakeResponse(responses[0])
    monkeypatch.setattr("senmiva_analysis.infrastructure.color_protocol._open_response", transport)
    settings = Settings(api_key=KEY, provider="openai", openai_api_key=OPENAI_KEY)
    provider = OpenAIColorProvider(settings)
    with TestClient(create_app(settings, openai_provider=UnusedSkinProvider(), color_provider=provider)) as client:
        yield client, provider, calls, responses


def payload(image=None):
    return {"request_id": REQUEST_ID, "image_base64": base64.b64encode(image or photo()).decode()}


def test_color_request_is_separate_strict_stateless_and_metadata_free(setup):
    client, _, calls, _ = setup
    original = photo(metadata=True)
    response = client.post("/v1/analyze/color", json=payload(original), headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"request_id": REQUEST_ID, "mode": "openai_color", "model_version": MODEL,
                               "prompt_version": PROMPT_VERSION, **observation()}
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1 and calls[0].full_url == ENDPOINT
    body = json.loads(calls[0].data)
    assert body["store"] is False and body["model"] == MODEL
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    assert "tools" not in body and "previous_response_id" not in body and "conversation" not in body
    assert REQUEST_ID not in calls[0].data.decode()
    assert "observed_features" not in calls[0].data.decode()
    assert "PRIVATE-PHOTO" not in calls[0].data.decode()
    encoded = body["input"][0]["content"][1]["image_url"].split(",")[1]
    clean = base64.b64decode(encoded)
    assert clean != original and b"PRIVATE-PHOTO" not in clean
    with Image.open(BytesIO(clean)) as image:
        assert image.format == "JPEG" and image.mode == "RGB" and not image.getexif()
    assert "image_base64" not in response.text and "confirmed_palette" not in response.text


@pytest.mark.parametrize("value", [
    {"image_quality": "limited", "undertone": "uncertain", "chroma": "uncertain", "quality_flags": ["uneven_lighting"]},
    {"image_quality": "not_assessable", "undertone": "uncertain", "chroma": "uncertain", "quality_flags": ["no_face"]},
    {"image_quality": "usable", "undertone": "uncertain", "chroma": "uncertain", "quality_flags": []},
])
def test_quality_correlated_uncertainty_is_a_result_not_a_failed_request(setup, value):
    client, _, calls, responses = setup
    responses[0] = envelope(value)
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 200 and response.json()["undertone"] == "uncertain"
    assert len(calls) == 1


@pytest.mark.parametrize("change", [
    {"undertone": "spring"}, {"undertone": 1}, {"chroma": "confident"},
    {"diagnosis": "PRIVATE-UPSTREAM"}, {"confidence": 0.99}, {"season": "winter"},
    {"quality_flags": ["blur", "blur"]}, {"quality_flags": ["occlusion"]},
    {"quality_flags": ["no_face"]}, {"image_quality": "limited", "quality_flags": ["low_light"]},
])
def test_unapproved_output_fails_closed_without_echo_fallback_or_retry(setup, change):
    client, _, calls, responses = setup
    responses[0] = envelope({**observation(), **change})
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and "PRIVATE-UPSTREAM" not in response.text
    assert len(calls) == 1


@pytest.mark.parametrize("change", [
    {"model": "gpt-4.1-mini"}, {"status": "incomplete"}, {"output": []}, {"error": {"message": "PRIVATE-UPSTREAM"}},
])
def test_unapproved_envelope_never_becomes_a_color_result(setup, change):
    client, _, calls, responses = setup
    responses[0] = {**envelope(), **change}
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and "PRIVATE-UPSTREAM" not in response.text and len(calls) == 1


def test_refusal_is_safe_and_never_retried(setup):
    client, _, calls, responses = setup
    value = envelope()
    value["output"][0]["content"] = [{"type": "refusal", "refusal": "PRIVATE-UPSTREAM"}]
    responses[0] = value
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 422 and "PRIVATE-UPSTREAM" not in response.text and len(calls) == 1


@pytest.mark.parametrize("image", [b"PRIVATE-INVALID-IMAGE", photo((223, 224)), photo((224, 4000)), photo(format="GIF")])
def test_invalid_image_does_not_reach_openai(setup, image):
    client, _, calls, _ = setup
    response = client.post("/v1/analyze/color", json=payload(image), headers=HEADERS)
    assert response.status_code == 422 and "PRIVATE-INVALID" not in response.text and not calls


def test_missing_photo_and_extra_personal_fields_are_rejected(setup):
    client, _, calls, _ = setup
    for value in [{"request_id": REQUEST_ID}, {**payload(), "organization_id": "PRIVATE-TENANT"}, {**payload(), "skin_type": "dry"}]:
        response = client.post("/v1/analyze/color", json=value, headers=HEADERS)
        assert response.status_code == 422 and "PRIVATE-TENANT" not in response.text
    assert not calls


def test_credentials_and_body_bounds_precede_color_body_processing(setup):
    client, _, calls, _ = setup
    assert client.post("/v1/analyze/color", content="PRIVATE-INVALID").status_code == 401
    assert client.post("/v1/analyze/color", json=payload(), headers=[("X-Analysis-Key", KEY), ("X-Analysis-Key", KEY)]).status_code == 401
    assert client.post("/v1/analyze/color", content="PRIVATE-INVALID", headers=HEADERS).status_code == 415
    assert client.post("/v1/analyze/color", content="x", headers={**HEADERS, "Content-Type": "application/json", "Content-Length": str(PrivateAnalysisBoundary.EXPERIMENTAL_MAX_BODY_BYTES + 1)}).status_code == 413
    assert not calls


def test_oversized_provider_response_is_bounded_and_not_echoed(setup):
    client, _, calls, responses = setup
    responses[0] = {**envelope(), "private_payload": "x" * (33 * 1024)}
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and "private_payload" not in response.text and len(calls) == 1


def test_transport_timeout_never_retries(setup):
    client, _, calls, responses = setup
    responses[0] = TimeoutError("PRIVATE-UPSTREAM")
    response = client.post("/v1/analyze/color", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and "PRIVATE-UPSTREAM" not in response.text and len(calls) == 1


def test_mock_configuration_cannot_call_color_provider_or_silently_fallback():
    with pytest.raises(ProviderUnavailableError):
        OpenAIColorProvider(Settings(api_key=KEY, provider="mock"))
    with TestClient(create_app(Settings(api_key=KEY, provider="mock"))) as client:
        assert client.post("/v1/analyze/color", json=payload(), headers=HEADERS).status_code == 503


def test_color_concurrency_is_rejected_before_body_and_releases(setup, monkeypatch):
    client, provider, calls, _ = setup
    entered, release = threading.Event(), threading.Event()
    original = provider.analyze
    def blocking(image):
        entered.set()
        assert release.wait(5)
        return original(image)
    monkeypatch.setattr(provider, "analyze", blocking)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/v1/analyze/color", json=payload(), headers=HEADERS)
        assert entered.wait(5)
        try:
            response = client.post("/v1/analyze/color", content="PRIVATE-INVALID", headers={**HEADERS, "Content-Type": "application/json"})
            assert response.status_code == 429 and "PRIVATE-INVALID" not in response.text
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(calls) == 1
