import os
from pathlib import Path
import re
from dataclasses import dataclass, field

from senmiva_analysis.application.ports import ProviderUnavailableError


@dataclass(frozen=True, slots=True)
class Settings:
    api_key: str = field(repr=False)
    provider: str = "mock"
    ml_workspace: Path | None = field(default=None, repr=False)
    photo_manifest: str = "skin-all-001"
    photo_run: str = "skin-all-head-001"
    ingredient_manifest: str = "ingredients-001"
    ingredient_run: str = "ingredients-linear-001"
    device: str = "auto"
    openai_api_key: str = field(default="", repr=False)
    openai_timeout_seconds: float = 30
    beauty_makeup_enabled: bool = False
    beauty_makeup_timeout_seconds: float = 60
    beauty_preview_enabled: bool = False

    def __post_init__(self) -> None:
        if len(self.api_key) < 32 or self.api_key.startswith("replace-"):
            raise ValueError("ANALYSIS_API_KEY must be a unique random secret of at least 32 characters.")
        if self.provider == "pytorch":
            raise ProviderUnavailableError("PyTorch inference is not implemented; startup refused.")
        if self.provider not in ("mock", "experimental", "openai"):
            raise ValueError("ANALYSIS_PROVIDER must be mock, experimental or openai. Unknown providers cannot fall back.")
        if self.provider == "experimental" and self.ml_workspace is None:
            raise ValueError("SENMIVA_ML_WORKSPACE is required for experimental inference.")
        if self.provider != "openai" and self.device not in ("auto", "cpu", "cuda"):
            raise ValueError("ANALYSIS_DEVICE must be auto, cpu or cuda.")
        if self.provider != "openai" and any(not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value) for value in
               (self.photo_manifest, self.photo_run, self.ingredient_manifest, self.ingredient_run)):
            raise ValueError("Analysis artifact names must be bounded local identifiers.")
        if self.provider == "openai":
            if not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,500}", self.openai_api_key):
                raise ValueError("OPENAI_API_KEY must be configured privately for openai analysis.")
            if not 0 < self.openai_timeout_seconds <= 30:
                raise ValueError("ANALYSIS_OPENAI_TIMEOUT_SECONDS must be greater than zero and at most 30.")
        if type(self.beauty_makeup_enabled) is not bool:
            raise ValueError("ANALYSIS_BEAUTY_MAKEUP_ENABLED must be true or false.")
        if self.beauty_makeup_enabled and self.provider != "openai":
            raise ValueError("Makeup previews require the explicitly configured openai provider.")
        if type(self.beauty_preview_enabled) is not bool:
            raise ValueError("ANALYSIS_BEAUTY_PREVIEW_ENABLED must be true or false.")
        if self.beauty_preview_enabled and self.provider != "openai":
            raise ValueError("Beauty previews require the explicitly configured openai provider.")
        if not 0 < self.beauty_makeup_timeout_seconds <= 60:
            raise ValueError("ANALYSIS_BEAUTY_MAKEUP_TIMEOUT_SECONDS must be greater than zero and at most 60.")

    @classmethod
    def from_environment(cls) -> "Settings":
        makeup = os.environ.get("ANALYSIS_BEAUTY_MAKEUP_ENABLED", "false")
        preview = os.environ.get("ANALYSIS_BEAUTY_PREVIEW_ENABLED", "false")
        if makeup not in ("true", "false"):
            raise ValueError("ANALYSIS_BEAUTY_MAKEUP_ENABLED must be true or false.")
        if preview not in ("true", "false"):
            raise ValueError("ANALYSIS_BEAUTY_PREVIEW_ENABLED must be true or false.")
        return cls(
            api_key=os.environ.get("ANALYSIS_API_KEY", ""),
            provider=os.environ.get("ANALYSIS_PROVIDER", "mock"),
            ml_workspace=Path(os.environ["SENMIVA_ML_WORKSPACE"]) if os.environ.get("SENMIVA_ML_WORKSPACE") else None,
            photo_manifest=os.environ.get("ANALYSIS_PHOTO_MANIFEST", "skin-all-001"),
            photo_run=os.environ.get("ANALYSIS_PHOTO_RUN", "skin-all-head-001"),
            ingredient_manifest=os.environ.get("ANALYSIS_INGREDIENT_MANIFEST", "ingredients-001"),
            ingredient_run=os.environ.get("ANALYSIS_INGREDIENT_RUN", "ingredients-linear-001"),
            device=os.environ.get("ANALYSIS_DEVICE", "auto"),
            openai_api_key=os.environ.get("OPENAI_API_KEY", "") if os.environ.get("ANALYSIS_PROVIDER") == "openai" else "",
            openai_timeout_seconds=float(os.environ.get("ANALYSIS_OPENAI_TIMEOUT_SECONDS", "30")) if os.environ.get("ANALYSIS_PROVIDER") == "openai" else 30,
            beauty_makeup_enabled=makeup == "true",
            beauty_makeup_timeout_seconds=float(os.environ.get("ANALYSIS_BEAUTY_MAKEUP_TIMEOUT_SECONDS", "60")),
            beauty_preview_enabled=preview == "true",
        )
