from typing import Protocol
from uuid import UUID

from senmiva_analysis.domain.color import ColorAnalysisResponse, ColorObservation, MODEL, PROMPT_VERSION


class ColorAnalysisProvider(Protocol):
    def analyze(self, image: bytes) -> ColorObservation: ...


class AnalyzeColorAppearance:
    """Only an explicitly admitted photo reaches this independent colour purpose."""
    def __init__(self, provider: ColorAnalysisProvider):
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes) -> ColorAnalysisResponse:
        value = ColorObservation.model_validate(self._provider.analyze(image))
        return ColorAnalysisResponse(request_id=request_id, mode="openai_color", model_version=MODEL,
                                     prompt_version=PROMPT_VERSION, **value.model_dump())
