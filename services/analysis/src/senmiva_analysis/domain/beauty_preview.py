"""One transient image per durable generation slot; original source is supplied for every edit."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from senmiva_analysis.domain.beauty_makeup import BeautyMakeupImage, MAX_PREVIEW_BASE64

PROMPT_VERSION = "beauty-preview-v1"
PreviewKind = Literal["makeup", "hair_style", "hair_color"]
FaceShape = Literal["oval", "round", "square", "oblong", "heart", "diamond", "unsure"]
StylingDirection = Literal["balanced", "masculine", "feminine"]


class BeautyPreviewImage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    mime_type: Literal["image/jpeg"]
    image_base64: str = Field(min_length=8, max_length=MAX_PREVIEW_BASE64)

    @model_validator(mode="after")
    def bounded_jpeg(self):
        BeautyMakeupImage(id="soft", mime_type=self.mime_type, image_base64=self.image_base64)
        return self


class BeautyPreviewResponse(BeautyPreviewImage):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    kind: PreviewKind
    index: Literal[0, 1, 2]
    model_version: Literal["gpt-image-2.5-flare-2026-09-08"]
    prompt_version: Literal["beauty-preview-v1"]
