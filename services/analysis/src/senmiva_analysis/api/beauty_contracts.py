from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from senmiva_analysis.api.contracts import MAX_BASE64_CHARACTERS
from senmiva_analysis.domain.beauty_makeup import PaletteId
from senmiva_analysis.domain.beauty_preview import PreviewKind, FaceShape, StylingDirection


class BeautyPhotoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    image_base64: str = Field(min_length=4, max_length=MAX_BASE64_CHARACTERS, strict=True)


class BeautyMakeupRequest(BeautyPhotoRequest):
    palette_id: PaletteId


class BeautyPreviewRequest(BeautyMakeupRequest):
    kind: PreviewKind
    index: int = Field(ge=0, le=2, strict=True)
    face_shape: FaceShape
    styling_direction: StylingDirection = "balanced"
