from typing import Protocol
from uuid import UUID

from senmiva_analysis.domain.beauty_makeup import BeautyMakeupImage, BeautyMakeupResponse, PaletteId, MODEL, PROMPT_VERSION


class BeautyMakeupProvider(Protocol):
    def generate(self, image: bytes, palette_id: PaletteId) -> list[BeautyMakeupImage]: ...


class GenerateBeautyMakeup:
    """The BFF owns separate consent, confirmed palette, single-attempt and late-result admission."""
    def __init__(self, provider: BeautyMakeupProvider):
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes, palette_id: PaletteId) -> BeautyMakeupResponse:
        return BeautyMakeupResponse(request_id=request_id, mode="openai_beauty_makeup", model_version=MODEL,
                                    prompt_version=PROMPT_VERSION, images=self._provider.generate(image, palette_id))
