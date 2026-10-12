from uuid import UUID

from senmiva_analysis.application.ports import AnalysisProvider
from senmiva_analysis.domain.models import AnalysisResult, SkinProfile


class AnalyzeSkinProfile:
    def __init__(self, provider: AnalysisProvider) -> None:
        self._provider = provider

    def execute(self, request_id: UUID, profile: SkinProfile) -> AnalysisResult:
        return AnalysisResult(
            request_id=request_id,
            mode=self._provider.mode,
            model_version=self._provider.model_version,
            quality_status=self._provider.quality_status,
            observations=self._provider.analyze(profile),
            disclaimer=self._provider.disclaimer,
        )
