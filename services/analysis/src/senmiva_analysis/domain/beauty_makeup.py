"""Transient guest-photo makeup illustrations; no product-efficacy or biometric outputs."""
from typing import Literal
from uuid import UUID
import base64
import binascii

from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL = "gpt-image-2.5-flare-2026-09-08"
PROMPT_VERSION = "beauty-makeup-preview-v1"
MOODS = ("soft", "fresh", "defined")
MAX_PREVIEW_BYTES = 1024 * 1024
MAX_PREVIEW_BASE64 = ((MAX_PREVIEW_BYTES + 2) // 3) * 4
PALETTES = ("warm_soft", "warm_clear", "cool_soft", "cool_clear", "neutral_soft", "neutral_clear")
PaletteId = Literal["warm_soft", "warm_clear", "cool_soft", "cool_clear", "neutral_soft", "neutral_clear"]


class BeautyMakeupImage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: Literal["soft", "fresh", "defined"]
    image_base64: str = Field(min_length=8, max_length=MAX_PREVIEW_BASE64)
    mime_type: Literal["image/jpeg"]

    @model_validator(mode="after")
    def bounded_jpeg(self):
        try:
            raw = base64.b64decode(self.image_base64, validate=True)
            if (not raw.startswith(b"\xff\xd8\xff") or not raw.endswith(b"\xff\xd9") or
                len(raw) > MAX_PREVIEW_BYTES or base64.b64encode(raw).decode("ascii") != self.image_base64):
                raise ValueError
        except (ValueError, binascii.Error):
            raise ValueError("Invalid makeup preview.") from None
        return self


class BeautyMakeupResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    mode: Literal["openai_beauty_makeup"]
    model_version: Literal["gpt-image-2.5-flare-2026-09-08"]
    prompt_version: Literal["beauty-makeup-preview-v1"]
    images: list[BeautyMakeupImage] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def three_distinct_moods(self):
        if tuple(image.id for image in self.images) != MOODS or len({image.image_base64 for image in self.images}) != 3:
            raise ValueError("Invalid makeup previews.")
        return self
