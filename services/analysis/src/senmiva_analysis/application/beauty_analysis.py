from typing import Protocol
from uuid import UUID

from senmiva_analysis.domain.beauty import BeautyAnalysisResponse, BeautyObservation, MODEL, PROMPT_VERSION


class BeautyAnalysisProvider(Protocol):
    def analyze(self, image: bytes) -> BeautyObservation: ...


class AnalyzeBeautyAppearance:
    """The caller admits a fresh purpose-specific photo; observations never confirm preferences."""
    def __init__(self, provider: BeautyAnalysisProvider):
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes) -> BeautyAnalysisResponse:
        value = BeautyObservation.model_validate(self._provider.analyze(image))
        return BeautyAnalysisResponse(request_id=request_id, mode="openai_beauty", model_version=MODEL,
                                      prompt_version=PROMPT_VERSION, **value.model_dump())
