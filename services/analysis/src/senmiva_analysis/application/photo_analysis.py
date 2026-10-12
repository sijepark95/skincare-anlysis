from uuid import UUID

from senmiva_analysis.application.ports import PhotoAnalysisProvider
from senmiva_analysis.domain.models import PhotoAnalysisResult


class AnalyzePhotoAppearance:
    """The hosted provider receives pixels only, never questionnaire/tenant fields."""

    def __init__(self, provider: PhotoAnalysisProvider) -> None:
        self._provider = provider

    def execute(self, request_id: UUID, image: bytes | None) -> PhotoAnalysisResult:
        vision = None if image is None else self._provider.analyze(image)
        return PhotoAnalysisResult(request_id, "openai", self._provider.model_version,
                                   vision.image_quality if vision else "not_provided", (),
                                   self._provider.disclaimer, vision)
