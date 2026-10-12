import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from senmiva_analysis.api.app import create_app
from senmiva_analysis.api.boundary import PrivateAnalysisBoundary
from senmiva_analysis.application.ports import ProviderBusyError, ProviderUnavailableError
from senmiva_analysis.infrastructure.openai_provider import DISCLAIMER, OpenAIPhotoProvider, sanitize_photo
from senmiva_analysis.settings import Settings
from senmiva_training.vision_api import FEATURES, PINNED_MODEL, VisionApiResult, _validate_jpeg


KEY = "test-secret-only-32-characters-or-longer"
OPENAI_KEY = "sk-synthetic-private-key-for-mocked-api-only"
HEADERS = {"X-Analysis-Key": KEY}
REQUEST_ID = "fc5f39b9-4fc5-41da-9bf2-2f189d58e84b"


def generated_image(size=(640, 480), *, format="PNG", metadata=False):
    output = BytesIO()
    image = Image.new("RGB", size, (140, 110, 90))
    options = {}
    if metadata and format == "PNG":
        info = PngImagePlugin.PngInfo()
        info.add_text("personal-source-filename", "DO-NOT-SEND-PRIVATE-METADATA")
        options["pnginfo"] = info
    image.save(output, format=format, **options)
    return output.getvalue()


def observations(quality="usable", flags=None, value="not_visible"):
    return {"image_quality": quality, "quality_flags": flags or [],
            "observed_features": {feature: value for feature in FEATURES}}


@pytest.fixture
def setup(monkeypatch):
    calls = []
    response = [VisionApiResult("completed", PINNED_MODEL, observations(), None, 1)]
    class MockedVisionClient:
        def __init__(self, key, **kwargs):
            assert key == OPENAI_KEY
            assert kwargs["timeout_seconds"] <= 30
        def analyze(self, payload):
            calls.append(payload)
            if isinstance(response[0], Exception):
                raise response[0]
            return response[0]
    monkeypatch.setattr("senmiva_training.vision_api.VisionApiClient", MockedVisionClient)
    settings = Settings(api_key=KEY, provider="openai", openai_api_key=OPENAI_KEY)
    provider = OpenAIPhotoProvider(settings)
    with TestClient(create_app(settings, openai_provider=provider)) as client:
        yield client, provider, calls, response


@pytest.fixture
def payload():
    return {"request_id": REQUEST_ID, "concern_ids": ["texture"], "skin_type": "dry", "sensitive": True}


def test_openai_mode_health_and_other_provider_endpoints_fail_closed(setup, payload):
    client, _, calls, _ = setup
    assert client.get("/healthz").json() == {"status": "ok", "mode": "openai"}
    for route in ("/v1/analyze", "/v1/analyze/experimental"):
        assert client.post(route, json=payload, headers=HEADERS).status_code == 503
    assert not calls


def test_openai_photo_free_flow_never_calls_external_api(setup, payload):
    client, _, calls, _ = setup
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"request_id": REQUEST_ID, "mode": "openai", "model_version": PINNED_MODEL,
                               "quality_status": "not_provided", "observations": [], "disclaimer": DISCLAIMER, "vision": None}
    assert not calls
    assert response.headers["cache-control"] == "no-store"
    assert "access-control-allow-origin" not in response.headers


def test_photo_is_fresh_metadata_free_rgb_jpeg_and_answers_never_reach_adapter(setup, payload):
    client, _, calls, _ = setup
    original = generated_image(metadata=True)
    payload["image_base64"] = base64.b64encode(original).decode("ascii")
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 200
    result = response.json()
    assert result["vision"] == {"prompt_version": "visible-appearance-eval-v1", **observations()}
    assert result["observations"] == []
    assert "visual" not in result and "ingredients" not in result
    assert result["quality_status"] == "usable"
    assert len(calls) == 1 and calls[0] != original
    assert b"DO-NOT-SEND" not in calls[0]
    assert REQUEST_ID.encode() not in calls[0]
    _validate_jpeg(calls[0])
    with Image.open(BytesIO(calls[0])) as image:
        assert image.mode == "RGB" and image.size == (640, 480)
        assert not image.getexif() and "icc_profile" not in image.info
    assert "image_base64" not in response.text


@pytest.mark.parametrize("flags", [["no_face"], ["multiple_faces"], ["low_light"]])
def test_unassessable_response_is_a_safe_result_for_retake(setup, payload, flags):
    client, _, _, result = setup
    result[0] = VisionApiResult("completed", PINNED_MODEL, observations("not_assessable", flags, "not_assessable"), None, 1)
    payload["image_base64"] = base64.b64encode(generated_image()).decode()
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 200 and response.json()["quality_status"] == "not_assessable"


@pytest.mark.parametrize("value", ["%%%%", "data:image/png;base64,YQ==", "YQ", "éééé"])
def test_invalid_encoding_never_calls_api_or_echoes_input(setup, payload, value):
    client, _, calls, _ = setup
    payload["image_base64"] = value
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 422 and value not in response.text
    assert not calls


@pytest.mark.parametrize("image", [b"private-invalid-image", generated_image((223, 224)), generated_image((224, 4000)), generated_image(format="GIF")])
def test_rejected_image_has_no_external_attempt(setup, payload, image):
    client, _, calls, _ = setup
    payload["image_base64"] = base64.b64encode(image).decode()
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 422 and "private-invalid" not in response.text
    assert not calls


def test_animated_input_is_rejected_before_api(setup, payload):
    client, _, calls, _ = setup
    output = BytesIO()
    first = Image.new("RGB", (224, 224), "white")
    first.save(output, format="PNG", save_all=True, append_images=[Image.new("RGB", (224, 224), "black")], duration=100, loop=0)
    payload["image_base64"] = base64.b64encode(output.getvalue()).decode()
    assert client.post("/v1/analyze/openai", json=payload, headers=HEADERS).status_code == 422
    assert not calls


@pytest.mark.parametrize("result,status", [
    (VisionApiResult("refused", PINNED_MODEL, None, None, 1), 422),
    (VisionApiResult("unavailable", PINNED_MODEL, None, None, 1, "authentication"), 503),
    (VisionApiResult("completed", "unapproved-model", observations(), None, 1), 503),
    (VisionApiResult("completed", PINNED_MODEL, {**observations(), "diagnosis": "PRIVATE-UPSTREAM-TEXT"}, None, 1), 503),
    (RuntimeError("PRIVATE-UPSTREAM-TEXT"), 503),
])
def test_refusal_failure_and_unapproved_output_never_fallback_or_leak(setup, payload, result, status):
    client, _, calls, responses = setup
    responses[0] = result
    payload["image_base64"] = base64.b64encode(generated_image()).decode()
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == status and "PRIVATE-UPSTREAM" not in response.text
    assert len(calls) == 1


def test_auth_and_size_limits_precede_body_and_provider(setup, payload):
    client, _, calls, _ = setup
    assert client.post("/v1/analyze/openai", content="private-invalid", headers={"Content-Type": "application/json"}).status_code == 401
    assert client.post("/v1/analyze/openai", json=payload, headers=[("X-Analysis-Key", KEY), ("X-Analysis-Key", KEY)]).status_code == 401
    assert client.post("/v1/analyze/openai", content="private-invalid", headers=HEADERS).status_code == 415
    response = client.post("/v1/analyze/openai", content=b"x", headers={**HEADERS, "Content-Type": "application/json", "Content-Length": str(PrivateAnalysisBoundary.EXPERIMENTAL_MAX_BODY_BYTES + 1)})
    assert response.status_code == 413
    payload["organization_id"] = "private-tenant"
    response = client.post("/v1/analyze/openai", json=payload, headers=HEADERS)
    assert response.status_code == 422 and "private-tenant" not in response.text
    assert not calls


def test_concurrent_admission_rejects_before_second_body_and_releases(setup, payload, monkeypatch):
    client, provider, calls, _ = setup
    entered, release = threading.Event(), threading.Event()
    original = provider.analyze
    def blocking(image):
        entered.set()
        assert release.wait(5)
        return original(image)
    monkeypatch.setattr(provider, "analyze", blocking)
    payload["image_base64"] = base64.b64encode(generated_image()).decode()
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/v1/analyze/openai", json=payload, headers=HEADERS)
        assert entered.wait(5)
        try:
            response = client.post("/v1/analyze/openai", content="private-invalid", headers={**HEADERS, "Content-Type": "application/json"})
            assert response.status_code == 429 and "private-invalid" not in response.text
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(calls) == 1
    assert client.post("/v1/analyze/openai", json=payload, headers=HEADERS).status_code == 200


def test_provider_busy_lock_does_not_call_external_client(setup):
    _, provider, calls, _ = setup
    provider._slot.acquire()
    try:
        with pytest.raises(ProviderBusyError):
            provider.analyze(generated_image())
    finally:
        provider._slot.release()
    assert not calls


def test_sanitizer_keeps_aspect_ratio_and_strips_exif_orientation():
    original = Image.new("RGB", (2400, 1600), "white")
    exif = original.getexif()
    exif[274] = 6
    exif[270] = "PRIVATE-SOURCE-METADATA"
    buffer = BytesIO()
    original.save(buffer, format="JPEG", exif=exif)
    clean = sanitize_photo(buffer.getvalue())
    _validate_jpeg(clean)
    with Image.open(BytesIO(clean)) as image:
        assert image.size == (1024, 1536)
        assert not image.getexif()
    assert b"PRIVATE-SOURCE" not in clean


def test_openai_configuration_has_no_model_artifact_requirement_or_secret_repr(monkeypatch):
    settings = Settings(api_key=KEY, provider="openai", openai_api_key=OPENAI_KEY,
                        photo_run="unused-invalid-path", ingredient_run="unused-invalid-path")
    assert settings.ml_workspace is None and OPENAI_KEY not in repr(settings)
    for key in ("", "replace-private-key", "sk-short"):
        with pytest.raises(ValueError, match="OPENAI_API_KEY"):
            Settings(api_key=KEY, provider="openai", openai_api_key=key)
    for timeout in (0, 31, float("nan")):
        with pytest.raises(ValueError, match="TIMEOUT"):
            Settings(api_key=KEY, provider="openai", openai_api_key=OPENAI_KEY, openai_timeout_seconds=timeout)
    monkeypatch.setenv("ANALYSIS_API_KEY", KEY)
    monkeypatch.setenv("ANALYSIS_PROVIDER", "mock")
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_KEY)
    assert Settings.from_environment().openai_api_key == ""


def test_openai_startup_does_not_import_torch_or_checkpoint_modules():
    code = """
import builtins, json, sys
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.startswith(('torch', 'senmiva_training.photo_inference', 'senmiva_training.ingredient_inference')):
        raise RuntimeError('Model imports are forbidden in hosted photo mode')
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from senmiva_analysis.api.app import create_app
from senmiva_analysis.settings import Settings
create_app(Settings(api_key='test-secret-only-32-characters-or-longer', provider='openai', openai_api_key='sk-synthetic-private-key-for-mocked-api-only'))
assert not any(name.startswith('torch') for name in sys.modules)
print(json.dumps({'model_imports': 0, 'api_calls': 0}))
"""
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"model_imports": 0, "api_calls": 0}
