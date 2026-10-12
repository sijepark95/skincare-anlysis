import base64
from io import BytesIO
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from senmiva_analysis.api.app import create_app
from senmiva_analysis.domain.beauty_complete import CompleteObservation
from senmiva_analysis.infrastructure.beauty_complete_provider import ENDPOINT, OpenAIBeautyCompleteProvider
from senmiva_analysis.infrastructure.beauty_preview_provider import OpenAIBeautyPreviewProvider, preview_prompt
from senmiva_analysis.settings import Settings
from senmiva_training.vision_api import FEATURES

KEY = "test-secret-only-32-characters-or-longer"
REQUEST_ID = "839acebb-91cb-4e96-892e-f363f4962a61"
HEADERS = {"X-Analysis-Key": KEY}
MODEL = "gpt-4.1-mini-2025-04-14"


def photo(metadata=False):
    output = BytesIO()
    info = PngImagePlugin.PngInfo()
    if metadata:
        info.add_text("private", "PRIVATE-NAME-NOT-TO-BE-SENT")
    Image.new("RGB", (640, 480), (140, 110, 90)).save(output, "PNG", pnginfo=info)
    return output.getvalue()


def observation():
    return {
        "beauty": {"image_quality": "usable", "undertone": "warm", "chroma": "soft", "face_shape": "oval",
                   "eye_shape": "almond", "nose_shape": "medium", "lip_fullness": "full", "quality_flags": []},
        "skin": {"image_quality": "usable", "quality_flags": [], "observed_features": dict.fromkeys(FEATURES, "visible")},
        "animalVibe": "cat", "baseDepth": "medium",
    }


def envelope(value):
    return {"model": MODEL, "status": "completed", "error": None, "incomplete_details": None,
            "output": [{"type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": json.dumps(value), "annotations": []}]}]}


class FakeResponse:
    status = 200
    def __init__(self, value, endpoint=ENDPOINT):
        self.body = json.dumps(value).encode()
        self.headers = {"Content-Type": "application/json", "Content-Length": str(len(self.body))}
        self.offset, self.endpoint = 0, endpoint
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def geturl(self): return self.endpoint
    def read1(self, size):
        part = self.body[self.offset:self.offset + size]
        self.offset += len(part)
        return part


class UnusedProvider:
    def analyze(self, image): raise AssertionError("Legacy protocol must not handle combined requests")


@pytest.fixture
def setup(monkeypatch):
    calls, responses = [], [envelope(observation())]
    def transport(request, timeout):
        calls.append(request)
        assert 0 < timeout <= 30
        if isinstance(responses[0], Exception): raise responses[0]
        return FakeResponse(responses[0])
    monkeypatch.setattr("senmiva_analysis.infrastructure.beauty_complete_provider._open_response", transport)
    settings = Settings(api_key=KEY, provider="openai", openai_api_key="sk-synthetic-private-key-for-complete-mocked-api-only")
    with TestClient(create_app(settings, openai_provider=UnusedProvider(), color_provider=UnusedProvider(),
                               beauty_provider=UnusedProvider(), beauty_complete_provider=OpenAIBeautyCompleteProvider(settings))) as client:
        yield client, calls, responses


def payload():
    return {"request_id": REQUEST_ID, "image_base64": base64.b64encode(photo(True)).decode()}


def test_one_combined_call_is_metadata_free_and_strict(setup):
    client, calls, _ = setup
    response = client.post("/v1/analyze/beauty-complete", json=payload(), headers=HEADERS)
    assert response.status_code == 200
    value = response.json()
    assert set(value) == {"request_id", "mode", "model_version", "prompt_version", "beauty", "skin", "animalVibe", "baseDepth"}
    assert value["mode"] == "openai_beauty_complete" and value["prompt_version"] == "beauty-complete-v1"
    assert value["skin"]["prompt_version"] == "visible-appearance-eval-v1"
    assert value["beauty"]["request_id"] == REQUEST_ID
    assert len(calls) == 1 and response.headers["cache-control"] == "no-store"
    request = json.loads(calls[0].data)
    assert request["store"] is False and request["model"] == MODEL
    assert not any(key in request for key in ("tools", "previous_response_id", "conversation"))
    schema = request["text"]["format"]["schema"]
    assert request["text"]["format"]["strict"] is True
    assert schema["additionalProperties"] is False and schema["properties"]["skin"]["additionalProperties"] is False
    assert REQUEST_ID not in calls[0].data.decode() and "PRIVATE-NAME" not in calls[0].data.decode()
    raw = base64.b64decode(request["input"][0]["content"][1]["image_url"].split(",")[1])
    assert b"PRIVATE-NAME" not in raw
    assert "image_base64" not in response.text and "confidence" not in response.text


def test_skin_quality_does_not_destroy_usable_style(setup):
    client, calls, responses = setup
    value = observation()
    value["skin"] = {"image_quality": "limited", "quality_flags": ["resolution_limited"],
                     "observed_features": dict.fromkeys(FEATURES, "uncertain")}
    responses[0] = envelope(value)
    response = client.post("/v1/analyze/beauty-complete", json=payload(), headers=HEADERS)
    assert response.status_code == 200 and response.json()["beauty"]["image_quality"] == "usable"
    assert response.json()["skin"]["image_quality"] == "limited" and len(calls) == 1


@pytest.mark.parametrize("field,value", [("animalVibe", "lion"), ("baseDepth", "white"), ("confidence", 99), ("gender", "woman"), ("explanation", "diagnosis")])
def test_unsupported_model_fields_fail_closed(setup, field, value):
    client, calls, responses = setup
    body = observation()
    body[field] = value
    responses[0] = envelope(body)
    response = client.post("/v1/analyze/beauty-complete", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and len(calls) == 1
    assert str(value) not in response.text


@pytest.mark.parametrize("change", [
    {"animalVibe": "cat"}, {"baseDepth": "medium"},
])
def test_limited_style_requires_uncertain_transient_fields(change):
    value = observation()
    value["beauty"] = {key: ("limited" if key == "image_quality" else ["blur"] if key == "quality_flags" else "uncertain")
                       for key in value["beauty"]}
    value.update(animalVibe="uncertain", baseDepth="uncertain")
    CompleteObservation.model_validate(value)
    value.update(change)
    with pytest.raises(ValueError): CompleteObservation.model_validate(value)


def test_credentials_and_extra_input_rejected_without_provider(setup):
    client, calls, _ = setup
    assert client.post("/v1/analyze/beauty-complete", content="not json").status_code == 401
    assert client.post("/v1/analyze/beauty-complete", json={**payload(), "age": 30}, headers=HEADERS).status_code == 422
    assert calls == []


def test_no_retry_after_provider_timeout(setup):
    client, calls, responses = setup
    responses[0] = TimeoutError("DO-NOT-ECHO")
    response = client.post("/v1/analyze/beauty-complete", json=payload(), headers=HEADERS)
    assert response.status_code == 503 and len(calls) == 1 and "DO-NOT-ECHO" not in response.text


@pytest.mark.parametrize("kind", ["makeup", "hair_style", "hair_color"])
@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("direction", [None, "masculine", "feminine"])
def test_one_preview_is_one_original_photo_edit(monkeypatch, kind, index, direction):
    from senmiva_analysis.infrastructure.beauty_preview_provider import ENDPOINT as EDIT_ENDPOINT
    output = BytesIO()
    Image.new("RGB", (512, 768), (160, 90, 60)).save(output, "JPEG")
    generated = output.getvalue()
    calls = []
    def transport(request, timeout):
        calls.append(request)
        assert 0 < timeout <= 60
        return FakeResponse({"data": [{"b64_json": base64.b64encode(generated).decode()}]}, EDIT_ENDPOINT)
    monkeypatch.setattr("senmiva_analysis.infrastructure.beauty_preview_provider._open_response", transport)
    settings = Settings(api_key=KEY, provider="openai", openai_api_key="sk-synthetic-private-key-for-complete-mocked-api-only", beauty_preview_enabled=True)
    with TestClient(create_app(settings, openai_provider=UnusedProvider(), color_provider=UnusedProvider(), beauty_provider=UnusedProvider(),
                               beauty_complete_provider=UnusedProvider(), beauty_preview_provider=OpenAIBeautyPreviewProvider(settings))) as client:
        response = client.post("/v1/generate/beauty-preview", json={**payload(), "palette_id": "cool_soft", "kind": kind,
                               "index": index, "face_shape": "oval", **({"styling_direction": direction} if direction else {})}, headers=HEADERS)
    assert response.status_code == 200, response.text
    value = response.json()
    assert set(value) == {"request_id", "kind", "index", "mime_type", "image_base64", "model_version", "prompt_version"}
    assert value["index"] == index and value["kind"] == kind and value["prompt_version"] == "beauty-preview-v1"
    assert len(calls) == 1 and calls[0].full_url == EDIT_ENDPOINT
    assert b"PRIVATE-NAME" not in calls[0].data and REQUEST_ID.encode() not in calls[0].data
    assert b'name="store"' not in calls[0].data and b'name="n"\r\n\r\n1\r\n' in calls[0].data
    assert preview_prompt("cool_soft", kind, index, "oval", direction or "balanced").encode() in calls[0].data
    with Image.open(BytesIO(base64.b64decode(value["image_base64"]))) as result:
        assert result.format == "JPEG" and not result.getexif() and max(result.size) <= 1152


def test_preview_flags_and_kind_specific_preservation():
    with pytest.raises(ValueError): Settings(api_key=KEY, provider="mock", beauty_preview_enabled=True)
    with pytest.raises(ValueError): Settings(api_key=KEY, beauty_preview_enabled="true")
    for bad in (True, -1, 3, "1"):
        with pytest.raises(ValueError): preview_prompt("cool_soft", "makeup", bad, "oval")
    assert "Preserve hairstyle, hair colour" in preview_prompt("cool_soft", "makeup", 0, "oval")
    assert "Preserve original hair colour, cosmetics" in preview_prompt("cool_soft", "hair_style", 1, "round")
    assert "Preserve original hairstyle, length, texture, cosmetics" in preview_prompt("cool_soft", "hair_color", 2, "heart")


def test_preview_disabled_and_strict_slots_do_not_invoke_provider(setup):
    client, calls, _ = setup
    body = {**payload(), "palette_id": "cool_soft", "kind": "makeup", "index": 0, "face_shape": "oval"}
    assert client.post("/v1/generate/beauty-preview", json=body, headers=HEADERS).status_code == 503
    for change in ({"index": True}, {"index": "0"}, {"index": 3}, {"prompt": "custom"}, {"kind": "body"}, {"face_shape": "guess"}, {"styling_direction": "man"}, {"styling_direction": "custom prompt"}, {"styling_direction": True}, {"gender": "man"}):
        assert client.post("/v1/generate/beauty-preview", json={**body, **change}, headers=HEADERS).status_code == 422
    assert calls == []


@pytest.mark.parametrize("index, makeup, hairstyle", [(0, "Natural skin finish", "textured short crop"), (1, "Groomed brows", "curtain part"), (2, "Subtle definition", "soft quiff")])
def test_masculine_style_changes_only_cosmetics_or_hair(index, makeup, hairstyle):
    prompt = preview_prompt("cool_soft", "makeup", index, "oval", "masculine")
    assert makeup in prompt and "Preserve hairstyle, hair colour" in prompt
    assert "Never feminize or masculinize" in prompt and "Preserve facial hair" in prompt
    assert "not their gender or a demographic inference" in prompt
    hair = preview_prompt("cool_soft", "hair_style", index, "oval", "masculine")
    assert hairstyle in hair and "Preserve original hair colour, cosmetics" in hair
    assert "chin-length bob" not in hair and "Long flowing layers" not in hair


def test_styling_defaults_and_feminine_balanced_preserve_existing_edits():
    assert preview_prompt("cool_soft", "makeup", 0, "oval") == preview_prompt("cool_soft", "makeup", 0, "oval", "balanced")
    assert "chin-length bob" in preview_prompt("cool_soft", "hair_style", 0, "oval", "feminine")
    assert "Long flowing layers" in preview_prompt("cool_soft", "hair_style", 2, "oval", "feminine")
    for bad in (None, True, "man", "MASculine", "custom prompt"):
        with pytest.raises(ValueError): preview_prompt("cool_soft", "makeup", 0, "oval", bad)
