from typing import Protocol
from uuid import UUID

from senmiva_analysis.domain.beauty import BeautyAnalysisResponse, MODEL, PROMPT_VERSION as STYLE_PROMPT_VERSION
from senmiva_analysis.domain.beauty_complete import CompleteObservation, BeautyCompleteResponse, SkinVision, PROMPT_VERSION


class BeautyCompleteProvider(Protocol):
    def analyze(self, image: bytes) -> CompleteObservation: ...


class AnalyzeBeautyComplete:
    """Only the BFF may admit a fresh capture under the new combined-photo purpose."""
    def __init__(self, provider: BeautyCompleteProvider):
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes) -> BeautyCompleteResponse:
        value = CompleteObservation.model_validate(self._provider.analyze(image))
        return BeautyCompleteResponse(
            request_id=request_id, mode="openai_beauty_complete", model_version=MODEL, prompt_version=PROMPT_VERSION,
            beauty=BeautyAnalysisResponse(request_id=request_id, mode="openai_beauty", model_version=MODEL,
                                          prompt_version=STYLE_PROMPT_VERSION, **value.beauty.model_dump()),
            skin=SkinVision(prompt_version="visible-appearance-eval-v1", **value.skin.model_dump()),
            animalVibe=value.animalVibe, baseDepth=value.baseDepth,
        )
