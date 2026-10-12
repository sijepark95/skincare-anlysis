import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import threading

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from senmiva_analysis.api.app import create_app
from senmiva_analysis.api.boundary import PrivateAnalysisBoundary
from senmiva_analysis.application.ports import ProviderUnavailableError
from senmiva_analysis.domain.beauty_makeup import MODEL, PROMPT_VERSION
from senmiva_analysis.infrastructure.beauty_makeup_provider import ENDPOINT, OpenAIBeautyMakeupProvider, MAX_PROVIDER_BYTES
from senmiva_analysis.settings import Settings

KEY = "test-secret-only-32-characters-or-longer"
OPENAI_KEY = "sk-synthetic-private-key-for-mocked-makeup-only"
REQUEST_ID = "839acebb-91cb-4e96-892e-f363f4962a61"
HEADERS = {"X-Analysis-Key": KEY}
PATH = "/v1/generate/beauty-makeup"


def photo(color=(140, 110, 90), size=(640, 960), format="JPEG", metadata=False):
    output = BytesIO()
    options = {}
    if metadata:
        exif = Image.Exif()
        exif[270] = "PRIVATE-GENERATED-METADATA"
        options["exif"] = exif
    Image.new("RGB", size, color).save(output, format=format, **options)
    return output.getvalue()


def payload(image=None):
    return {"request_id": REQUEST_ID, "image_base64": base64.b64encode(image or photo()).decode(), "palette_id": "cool_soft"}


def envelope(color=(140, 110, 90), **options):
    return {"created": 1800000000, "data": [{"b64_json": base64.b64encode(photo(color,metadata=True,**options)).decode(),
            "revised_prompt": "PRIVATE-PROVIDER-PROSE"}], "usage": {"total_tokens": 100}}


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


class UnusedProvider:
    def analyze(self, image): raise AssertionError("Other purposes must not handle makeup generation")


@pytest.fixture
def setup(monkeypatch):
    calls = []
    responses = [envelope((120, 80, 100)), envelope((160, 90, 120)), envelope((100, 50, 90))]
    def transport(request, timeout):
        calls.append(request)
        assert 0 < timeout <= 60
        value = responses[len(calls) - 1]
        if isinstance(value, Exception): raise value
        return FakeResponse(value)
    monkeypatch.setattr("senmiva_analysis.infrastructure.beauty_makeup_provider._open_response", transport)
    settings = Settings(api_key=KEY, provider="openai", openai_api_key=OPENAI_KEY, beauty_makeup_enabled=True)
    provider = OpenAIBeautyMakeupProvider(settings)
    with TestClient(create_app(settings, openai_provider=UnusedProvider(), color_provider=UnusedProvider(),
                               beauty_provider=UnusedProvider(), beauty_makeup_provider=provider)) as client:
        yield client, provider, calls, responses


def test_three_real_edits_have_strict_moods_sanitized_metadata_and_no_identifier(setup):
    client, _, calls, _ = setup
    original = photo(metadata=True)
    response = client.post(PATH,json=payload(original),headers=HEADERS)
    assert response.status_code == 200
    result = response.json()
    assert set(result) == {"request_id", "mode", "model_version", "prompt_version", "images"}
    assert result["request_id"] == REQUEST_ID and result["mode"] == "openai_beauty_makeup"
    assert result["model_version"] == MODEL and result["prompt_version"] == PROMPT_VERSION
    assert [item["id"] for item in result["images"]] == ["soft", "fresh", "defined"]
    assert len({item["image_base64"] for item in result["images"]}) == 3
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE-PROVIDER-PROSE" not in response.text
    assert len(calls) == 3
    for call in calls:
        assert call.full_url == ENDPOINT and call.get_method() == "POST"
        assert call.get_header("Authorization") == "Bearer " + OPENAI_KEY
        assert b'filename="photo.jpg"' in call.data and b"PRIVATE-GENERATED-METADATA" not in call.data
        assert REQUEST_ID.encode() not in call.data and b"store" not in call.data
        assert MODEL.encode() in call.data and b"muted cool rose" in call.data
        assert b'"size"\r\n\r\n1024x1536' in call.data and b'"n"\r\n\r\n1' in call.data
        assert original not in call.data
        assert b"files/" not in call.data and b"input_fidelity" not in call.data
    for item in result["images"]:
        assert set(item) == {"id", "image_base64", "mime_type"} and item["mime_type"] == "image/jpeg"
        raw = base64.b64decode(item["image_base64"])
        assert b"PRIVATE-GENERATED-METADATA" not in raw and len(raw) <= 1024 * 1024
        with Image.open(BytesIO(raw)) as image:
            assert image.format == "JPEG" and image.mode == "RGB" and not image.getexif()
            assert image.width <= 768 and image.height <= 1152


@pytest.mark.parametrize("change", [{"palette_id":"spring"},{"palette_id":None},{"request_id":"tenant-id"},
                                   {"organization_id":"PRIVATE-TENANT"},{"prompt":"PRIVATE-INSTRUCTION"}])
def test_unconfirmed_or_open_ended_inputs_cannot_reach_generation(setup, change):
    client, _, calls, _ = setup
    response = client.post(PATH,json={**payload(),**change},headers=HEADERS)
    assert response.status_code == 422 and "PRIVATE" not in response.text and not calls


@pytest.mark.parametrize("image", [b"PRIVATE-INVALID", photo(size=(223,224)), photo(format="GIF"), photo(size=(224,4000))],
                         ids=["invalid-bytes", "too-small", "animated-format", "too-narrow-after-resize"])
def test_invalid_images_do_not_trigger_any_edits(setup,image):
    client, _, calls, _ = setup
    response = client.post(PATH,json=payload(image),headers=HEADERS)
    assert response.status_code == 422 and "PRIVATE-INVALID" not in response.text and not calls


@pytest.mark.parametrize("bad", [TimeoutError("PRIVATE-DETAIL"), {"error":{"message":"PRIVATE-DETAIL"}}, {"data":[]},
    {"data":[{"url":"https://private.invalid/face.jpg"}]}, {"data":[{"b64_json":"PRIVATE-INVALID"}]},
    envelope(format="PNG"), envelope(size=(223,224)), envelope(size=(224,4000)), {**envelope(),"private":"x"*(MAX_PROVIDER_BYTES+1)}],
    ids=["timeout", "error", "missing-output", "remote-url", "invalid-base64", "wrong-format", "small-output", "narrow-after-resize", "oversized-output"])
def test_provider_failure_stops_the_batch_without_retry_echo_partial_result_or_url_fetch(setup,bad):
    client, _, calls, responses = setup
    responses[1] = bad
    response = client.post(PATH,json=payload(),headers=HEADERS)
    assert response.status_code == 503 and "PRIVATE" not in response.text and "images" not in response.text
    assert len(calls) == 2


def test_identical_outputs_are_not_presented_as_three_distinct_edits(setup):
    client, _, calls, responses = setup
    responses[1] = responses[0]
    responses[2] = responses[0]
    response = client.post(PATH,json=payload(),headers=HEADERS)
    assert response.status_code == 503 and len(calls) == 3


def test_private_authentication_body_bounds_and_shared_slot_precede_processing(setup,monkeypatch):
    client, provider, calls, _ = setup
    assert client.post(PATH,content="PRIVATE-INVALID").status_code == 401
    assert client.post(PATH,json=payload(),headers=[("X-Analysis-Key",KEY),("X-Analysis-Key",KEY)]).status_code == 401
    assert client.post(PATH,content="PRIVATE-INVALID",headers=HEADERS).status_code == 415
    assert client.post(PATH,content="x",headers={**HEADERS,"Content-Type":"application/json",
        "Content-Length":str(PrivateAnalysisBoundary.EXPERIMENTAL_MAX_BODY_BYTES+1)}).status_code == 413
    entered,release=threading.Event(),threading.Event()
    original=provider.generate
    def blocking(image,palette_id):
        entered.set()
        assert release.wait(5)
        return original(image,palette_id)
    monkeypatch.setattr(provider,"generate",blocking)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first=pool.submit(client.post,PATH,json=payload(),headers=HEADERS)
        assert entered.wait(5)
        try:
            for path in [PATH,"/v1/analyze/beauty","/v1/analyze/openai","/v1/analyze/color"]:
                response=client.post(path,content="PRIVATE-INVALID",headers={**HEADERS,"Content-Type":"application/json"})
                assert response.status_code == 429 and "PRIVATE" not in response.text
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(calls) == 3


def test_configuration_defaults_off_and_unknown_flag_cannot_fall_back(monkeypatch):
    settings=Settings(api_key=KEY,provider="openai",openai_api_key=OPENAI_KEY)
    assert not settings.beauty_makeup_enabled
    with pytest.raises(ProviderUnavailableError): OpenAIBeautyMakeupProvider(settings)
    with TestClient(create_app(settings)) as client:
        assert client.post(PATH,json=payload(),headers=HEADERS).status_code == 503
    for kwargs in [{"beauty_makeup_enabled":"yes"},{"beauty_makeup_timeout_seconds":61},
                   {"beauty_makeup_timeout_seconds":float("nan")}]:
        with pytest.raises(ValueError): Settings(api_key=KEY,**kwargs)
    with pytest.raises(ValueError): Settings(api_key=KEY,provider="mock",beauty_makeup_enabled=True)
    monkeypatch.setenv("ANALYSIS_BEAUTY_MAKEUP_ENABLED","yes")
    with pytest.raises(ValueError): Settings.from_environment()
