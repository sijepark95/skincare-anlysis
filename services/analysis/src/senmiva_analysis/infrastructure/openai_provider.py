"""Consent-gated hosted appearance observation with in-memory image sanitation.

The shared strict protocol has no ML runtime dependencies. Only this explicitly
configured provider imports it; no checkpoints, Torch, training data or files are
read. The application owns consent and durable external-attempt admission.
"""

from io import BytesIO
import threading
import warnings

from senmiva_analysis.application.ports import ImageRejectedError, ProviderBusyError, ProviderRefusedError, ProviderUnavailableError
from senmiva_analysis.domain.models import PhotoAppearance
from senmiva_analysis.settings import Settings


PINNED_MODEL = "gpt-4.1-mini-2025-04-14"
MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_DECODED_PIXELS = 25_000_000
MAX_OUTBOUND_BYTES = 4 * 1024 * 1024
DISCLAIMER = ("AI observations describe visible cosmetic features in this photo, not a diagnosis or calibrated measurement. "
              "Lighting, makeup and camera quality can affect results. Photos are processed in memory by this app "
              "and are not saved or used for training. With your consent, a metadata-stripped photo is sent to OpenAI; "
              "provider retention may apply.")


def sanitize_photo(payload: bytes) -> bytes:
    """Decode a static bounded image and re-encode fresh RGB pixels without metadata."""
    try:
        from PIL import Image, ImageOps
        if not isinstance(payload, bytes) or not 1 <= len(payload) <= MAX_INPUT_BYTES:
            raise ValueError
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as source:
                if (source.format not in ("JPEG", "PNG", "WEBP") or
                    getattr(source, "n_frames", 1) != 1 or getattr(source, "is_animated", False) or
                    min(source.size) < 224 or source.width * source.height > MAX_DECODED_PIXELS):
                    raise ValueError
                source.verify()
            with Image.open(BytesIO(payload)) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
                if min(oriented.size) < 224:
                    raise ValueError
                # Reconstruct pixels rather than propagate EXIF/ICC/XMP/PNG text.
                clean = Image.new("RGB", oriented.size, "white")
                if "A" in oriented.getbands():
                    rgba = oriented.convert("RGBA")
                    clean.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    clean.paste(oriented.convert("RGB"))
                output = BytesIO()
                clean.save(output, format="JPEG", quality=90, optimize=False, progressive=False)
                encoded = output.getvalue()
                if len(encoded) > MAX_OUTBOUND_BYTES:
                    raise ValueError
                return encoded
    except Exception:
        raise ImageRejectedError("Use a bounded static JPEG, PNG or WebP image.") from None


class OpenAIPhotoProvider:
    model_version = PINNED_MODEL
    disclaimer = DISCLAIMER

    def __init__(self, settings: Settings) -> None:
        try:
            from PIL import Image  # Check image runtime without importing ML models.
            from senmiva_training.vision_api import VisionApiClient, validate_observations
            self._client = VisionApiClient(settings.openai_api_key,
                                          timeout_seconds=settings.openai_timeout_seconds)
            self._validate = validate_observations
            self._slot = threading.Lock()
        except Exception:
            raise ProviderUnavailableError("OpenAI photo observation is not configured; startup refused.") from None

    def analyze(self, image: bytes) -> PhotoAppearance:
        if not self._slot.acquire(blocking=False):
            raise ProviderBusyError("Analysis is busy; try again.")
        encoded = None
        try:
            encoded = sanitize_photo(image)
            result = self._client.analyze(encoded)
            if result.status == "refused":
                raise ProviderRefusedError("Photo observation was declined.")
            if result.status != "completed" or result.model != PINNED_MODEL:
                raise ProviderUnavailableError("OpenAI photo observation is unavailable.")
            value = self._validate(result.observations)
            return PhotoAppearance("visible-appearance-eval-v1", value["image_quality"],
                                   tuple(value["quality_flags"]), value["observed_features"])
        except (ImageRejectedError, ProviderBusyError, ProviderRefusedError, ProviderUnavailableError):
            raise
        except Exception:
            raise ProviderUnavailableError("OpenAI photo observation is unavailable.") from None
        finally:
            encoded = None
            self._slot.release()
