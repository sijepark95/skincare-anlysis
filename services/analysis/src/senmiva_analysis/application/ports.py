from typing import Protocol

from senmiva_analysis.domain.models import IngredientOutput, Observation, PhotoAppearance, SkinProfile, VisualOutput


class ProviderUnavailableError(RuntimeError):
    """The requested provider cannot perform analysis; do not fall back silently."""


class ImageRejectedError(ValueError):
    """Bounded image input was rejected without exposing its contents."""


class ProviderBusyError(RuntimeError):
    """The single in-process inference slot is occupied."""


class ProviderRefusedError(ValueError):
    """The hosted provider declined observation; no raw refusal text escapes."""


class PhotoAnalysisProvider(Protocol):
    model_version: str
    disclaimer: str

    def analyze(self, image: bytes) -> PhotoAppearance: ...


class ExperimentalProvider(Protocol):
    model_version: str
    disclaimer: str

    def analyze(self, profile: SkinProfile, image: bytes | None) -> tuple[VisualOutput | None, IngredientOutput]: ...


class AnalysisProvider(Protocol):
    mode: str
    model_version: str
    quality_status: str
    disclaimer: str

    def analyze(self, profile: SkinProfile) -> tuple[Observation, ...]: ...
