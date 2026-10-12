from typing import Protocol
from uuid import UUID

from senmiva_analysis.domain.beauty_makeup import PaletteId, MODEL
from senmiva_analysis.domain.beauty_preview import BeautyPreviewImage, BeautyPreviewResponse, PreviewKind, FaceShape, StylingDirection, PROMPT_VERSION


class BeautyPreviewProvider(Protocol):
    def generate(self, image: bytes, palette_id: PaletteId, kind: PreviewKind, index: int, face_shape: FaceShape, styling_direction: StylingDirection = "balanced") -> BeautyPreviewImage: ...


class GenerateBeautyPreview:
    """The BFF owns nine-slot plan admission, separate consent and rejection of stale results."""
    def __init__(self, provider: BeautyPreviewProvider):
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes, palette_id: PaletteId, kind: PreviewKind, index: int, face_shape: FaceShape, styling_direction: StylingDirection = "balanced") -> BeautyPreviewResponse:
        value = BeautyPreviewImage.model_validate(self._provider.generate(image, palette_id, kind, index, face_shape, styling_direction))
        return BeautyPreviewResponse(request_id=request_id, kind=kind, index=index, model_version=MODEL,
                                     prompt_version=PROMPT_VERSION, **value.model_dump())
