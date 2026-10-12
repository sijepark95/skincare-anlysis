from uuid import UUID

from senmiva_analysis.application.ports import ExperimentalProvider
from senmiva_analysis.domain.models import ExperimentalResult, SkinProfile


class AnalyzeExperimentalProfile:
    def __init__(self, provider: ExperimentalProvider) -> None:
        self._provider = provider

    def execute(self, request_id: UUID, profile: SkinProfile, image: bytes | None) -> ExperimentalResult:
        visual, ingredients = self._provider.analyze(profile, image)
        return ExperimentalResult(request_id, "experimental", self._provider.model_version,
                                  "experimental", (), self._provider.disclaimer, visual, ingredients)
