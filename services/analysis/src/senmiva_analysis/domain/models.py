from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


class ConcernId(StrEnum):
    DEHYDRATION = "dehydration"
    TEXTURE = "texture"
    UNEVEN_TONE = "uneven_tone"
    FINE_LINES = "fine_lines"


class SkinType(StrEnum):
    NORMAL = "normal"
    DRY = "dry"
    OILY = "oily"
    COMBINATION = "combination"
    UNSURE = "unsure"


class Level(StrEnum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


@dataclass(frozen=True, slots=True)
class SkinProfile:
    concern_ids: tuple[ConcernId, ...]
    skin_type: SkinType
    sensitive: bool

    def __post_init__(self) -> None:
        if not 1 <= len(self.concern_ids) <= 4:
            raise ValueError("Choose between one and four concerns.")
        if len(set(self.concern_ids)) != len(self.concern_ids):
            raise ValueError("Concern IDs must be unique.")


@dataclass(frozen=True, slots=True)
class Observation:
    concern_id: ConcernId
    level: Level
    score: float

    def __post_init__(self) -> None:
        if not 0 <= self.score <= 1:
            raise ValueError("Observation score must be between zero and one.")


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    request_id: UUID
    mode: str
    model_version: str
    quality_status: str
    observations: tuple[Observation, ...]
    disclaimer: str


@dataclass(frozen=True, slots=True)
class ModelProbability:
    code: str
    probability: float


@dataclass(frozen=True, slots=True)
class VisualHead:
    key: str
    label: str
    predicted_code: str
    probabilities: tuple[ModelProbability, ...]


@dataclass(frozen=True, slots=True)
class VisualOutput:
    model_version: str
    heads: tuple[VisualHead, ...]


@dataclass(frozen=True, slots=True)
class IngredientCandidate:
    ingredient: str
    score: float


@dataclass(frozen=True, slots=True)
class IngredientOutput:
    model_version: str
    candidates: tuple[IngredientCandidate, ...]
    input_coverage: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ExperimentalResult:
    request_id: UUID
    mode: str
    model_version: str
    quality_status: str
    observations: tuple[Observation, ...]
    disclaimer: str
    visual: VisualOutput | None
    ingredients: IngredientOutput


@dataclass(frozen=True, slots=True)
class PhotoAppearance:
    prompt_version: str
    image_quality: str
    quality_flags: tuple[str, ...]
    observed_features: dict[str, str]


@dataclass(frozen=True, slots=True)
class PhotoAnalysisResult:
    request_id: UUID
    mode: str
    model_version: str
    quality_status: str
    observations: tuple[Observation, ...]
    disclaimer: str
    vision: PhotoAppearance | None
