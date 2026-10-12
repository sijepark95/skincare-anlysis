from senmiva_analysis.application.ports import ProviderUnavailableError
from senmiva_analysis.domain.models import Observation, SkinProfile


class PyTorchAnalysisProvider:
    """Explicit future integration boundary; no data loading or training occurs here."""

    mode = "model"
    model_version = "unavailable"
    quality_status = "unavailable"
    disclaimer = "A licensed and validated model has not been configured."

    def analyze(self, profile: SkinProfile) -> tuple[Observation, ...]:
        raise ProviderUnavailableError(
            "PyTorch inference is not implemented. Configure ANALYSIS_PROVIDER=mock for the demo."
        )
