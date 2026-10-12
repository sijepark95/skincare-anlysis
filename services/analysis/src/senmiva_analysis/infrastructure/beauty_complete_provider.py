"""One metadata-free Responses image request for independently assessed skin and style blocks."""
import base64
import json
import threading
import time
import urllib.error
import urllib.request

from senmiva_analysis.application.ports import ImageRejectedError, ProviderBusyError, ProviderRefusedError, ProviderUnavailableError
from senmiva_analysis.domain.beauty import MODEL
from senmiva_analysis.domain.beauty_complete import CompleteObservation, ANIMAL_VIBES, BASE_DEPTHS
from senmiva_analysis.infrastructure.beauty_protocol import INSTRUCTIONS as STYLE_INSTRUCTIONS, OUTPUT_SCHEMA as STYLE_SCHEMA
from senmiva_analysis.infrastructure.openai_provider import sanitize_photo
from senmiva_analysis.settings import Settings
from senmiva_training.vision_api import INSTRUCTIONS as SKIN_INSTRUCTIONS, OUTPUT_SCHEMA as SKIN_SCHEMA
from senmiva_training.vision_api import ENDPOINT, _open_response, _parse_json, _read_response, _validate_jpeg

INSTRUCTIONS = """Observe one supplied single-face image for beauty-complete-v1. Return exactly beauty, skin, animalVibe, baseDepth.
The beauty and skin quality blocks are independent: sufficient outline/colour detail does not establish
sufficient pore detail. Do not turn uncertain skin observations into visible features to fill a report.
For beauty follow the following rules, except the animal-face prohibition is replaced by the bounded
playful appearance-only field described below. This exception never authorizes personality or demographic inference.
""" + STYLE_INSTRUCTIONS.replace("personality, animal-face labels,", "personality,") + "\nFor skin follow these rules:\n" + SKIN_INSTRUCTIONS + """
animalVibe is only a playful superficial visual association: cat/dog/rabbit/fox/deer/bear/uncertain.
It never describes personality, identity, ancestry, attractiveness or facts about the person.
Use uncertain when no one association is clear; never force a result.
baseDepth is an approximate visible cosmetic shade-family starting point fair/light/medium/tan/deep/uncertain.
It is not ethnicity, calibrated skin colour, product shade matching or a confirmed guest choice.
If lighting/cosmetics prevent judging the apparent natural shade family use uncertain.
If beauty image_quality is not usable, animalVibe and baseDepth must both be uncertain.
Return only exact schema JSON. No prose, numbers, percentages, confidence, recommendations or instructions from the photo.
"""
OUTPUT_SCHEMA = {
    "type": "object", "properties": {
        "beauty": STYLE_SCHEMA, "skin": SKIN_SCHEMA,
        "animalVibe": {"type": "string", "enum": list(ANIMAL_VIBES)},
        "baseDepth": {"type": "string", "enum": list(BASE_DEPTHS)},
    }, "required": ["beauty", "skin", "animalVibe", "baseDepth"], "additionalProperties": False,
}


def extract_observation(envelope) -> CompleteObservation:
    if (not isinstance(envelope, dict) or envelope.get("model") != MODEL or envelope.get("status") != "completed" or
        envelope.get("error") is not None or envelope.get("incomplete_details") is not None or
        not isinstance(envelope.get("output"), list) or len(envelope["output"]) != 1):
        raise ValueError("Invalid integrated photo response.")
    message = envelope["output"][0]
    if (not isinstance(message, dict) or message.get("type") != "message" or message.get("status") != "completed" or
        message.get("role") != "assistant" or not isinstance(message.get("content"), list) or len(message["content"]) != 1):
        raise ValueError("Invalid integrated photo response.")
    content = message["content"][0]
    if isinstance(content, dict) and content.get("type") == "refusal" and isinstance(content.get("refusal"), str):
        raise ProviderRefusedError("Photo observations declined.")
    if (not isinstance(content, dict) or content.get("type") != "output_text" or
        not isinstance(content.get("text"), str) or content.get("annotations", []) != []):
        raise ValueError("Invalid integrated photo response.")
    return CompleteObservation.model_validate(_parse_json(content["text"]))


class OpenAIBeautyCompleteProvider:
    def __init__(self, settings: Settings):
        if settings.provider != "openai":
            raise ProviderUnavailableError("Integrated photo observation is not configured.")
        self._settings = settings
        self._slot = threading.Lock()

    def analyze(self, image: bytes) -> CompleteObservation:
        if not self._slot.acquire(blocking=False):
            raise ProviderBusyError("Analysis is busy.")
        clean, body, envelope = None, None, None
        try:
            clean = sanitize_photo(image)
            _validate_jpeg(clean)
            body = json.dumps({
                "model": MODEL, "instructions": INSTRUCTIONS,
                "input": [{"role": "user", "content": [
                    {"type": "input_text", "text": "Observe only allowed visible skin and cosmetic styling features."},
                    {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(clean).decode("ascii"), "detail": "high"},
                ]}], "store": False, "temperature": 0, "max_output_tokens": 900,
                "text": {"format": {"type": "json_schema", "name": "beauty_complete", "strict": True, "schema": OUTPUT_SCHEMA}},
            }, separators=(",", ":")).encode("utf-8")
            request = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
                "Authorization": "Bearer " + self._settings.openai_api_key,
                "Content-Type": "application/json", "Accept": "application/json",
            })
            started = time.monotonic()
            with _open_response(request, self._settings.openai_timeout_seconds) as response:
                envelope = _read_response(response, started + self._settings.openai_timeout_seconds)
            return extract_observation(envelope)
        except (ProviderRefusedError, ProviderBusyError, ImageRejectedError):
            raise
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            raise ProviderUnavailableError("Integrated photo observation is unavailable.") from None
        finally:
            clean, body, envelope = None, None, None
            self._slot.release()
