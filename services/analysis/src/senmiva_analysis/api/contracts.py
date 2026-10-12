from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from senmiva_analysis.domain.models import ConcernId, Level, SkinType


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: UUID
    concern_ids: list[ConcernId] = Field(min_length=1, max_length=4)
    skin_type: SkinType
    sensitive: bool = Field(strict=True)

    @field_validator("concern_ids")
    @classmethod
    def concerns_are_unique(cls, value: list[ConcernId]) -> list[ConcernId]:
        if len(set(value)) != len(value):
            raise ValueError("Concern IDs must be unique.")
        return value


class ObservationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    concern_id: ConcernId
    level: Level
    score: float = Field(ge=0, le=1)


class AnalyzeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    request_id: UUID
    mode: Literal["mock"]
    model_version: Literal["mock-1.0"]
    quality_status: Literal["demo"]
    observations: list[ObservationResponse]
    disclaimer: str


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_BASE64_CHARACTERS = ((MAX_IMAGE_BYTES + 2) // 3) * 4


class ExperimentalRequest(AnalyzeRequest):
    image_base64: str | None = Field(default=None, min_length=4, max_length=MAX_BASE64_CHARACTERS, strict=True)


class ProbabilityResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    code: str = Field(min_length=1, max_length=32)
    probability: float = Field(ge=0, le=1, allow_inf_nan=False)


class VisualHeadResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    key: Literal["sensitivity", "pigmentation", "wrinkles", "acne", "pores", "sagging", "keratin", "redness"]
    label: str = Field(min_length=1, max_length=64)
    predicted_code: str = Field(min_length=1, max_length=32)
    probabilities: list[ProbabilityResponse] = Field(min_length=2, max_length=3)


class VisualResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    model_version: str = Field(min_length=1, max_length=100)
    heads: list[VisualHeadResponse] = Field(min_length=8, max_length=8)


class IngredientCandidateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    ingredient: str = Field(min_length=1, max_length=256)
    score: float = Field(ge=0, le=1, allow_inf_nan=False)


class IngredientResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    model_version: str = Field(min_length=1, max_length=100)
    candidates: list[IngredientCandidateResponse] = Field(min_length=1, max_length=128)
    input_coverage: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(min_length=1, max_length=16)


class ExperimentalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    request_id: UUID
    mode: Literal["experimental"]
    model_version: str = Field(min_length=1, max_length=100)
    quality_status: Literal["experimental"]
    observations: list[ObservationResponse] = Field(max_length=0)
    disclaimer: str = Field(min_length=1, max_length=1000)
    visual: VisualResponse | None
    ingredients: IngredientResponse


AppearanceValue = Literal["visible", "not_visible", "uncertain", "not_assessable"]
QualityFlag = Literal["no_face", "multiple_faces", "blur", "low_light", "uneven_lighting", "occlusion", "makeup_or_filter", "face_not_fully_visible", "resolution_limited"]


class ObservedFeaturesResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    visible_redness: AppearanceValue
    visible_spots: AppearanceValue
    visible_pores: AppearanceValue
    visible_fine_lines: AppearanceValue
    visible_flaking: AppearanceValue


class PhotoAppearanceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    prompt_version: Literal["visible-appearance-eval-v1"]
    image_quality: Literal["usable", "limited", "not_assessable"]
    quality_flags: list[QualityFlag] = Field(max_length=9)
    observed_features: ObservedFeaturesResponse

    @model_validator(mode="after")
    def correlated_quality(self):
        if (len(set(self.quality_flags)) != len(self.quality_flags) or
            (self.image_quality == "usable" and self.quality_flags) or
            (self.image_quality != "usable" and not self.quality_flags) or
            (self.image_quality == "not_assessable" and any(value != "not_assessable" for value in self.observed_features.model_dump().values())) or
            (any(flag in self.quality_flags for flag in ("no_face", "multiple_faces")) and self.image_quality != "not_assessable")):
            raise ValueError("Invalid appearance quality protocol.")
        return self


class OpenAIPhotoResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    request_id: UUID
    mode: Literal["openai"]
    model_version: Literal["gpt-4.1-mini-2025-04-14"]
    quality_status: Literal["usable", "limited", "not_assessable", "not_provided"]
    observations: list[ObservationResponse] = Field(max_length=0)
    disclaimer: str = Field(min_length=1, max_length=1000)
    vision: PhotoAppearanceResponse | None

    @model_validator(mode="after")
    def quality_matches_photo(self):
        if self.quality_status != (self.vision.image_quality if self.vision else "not_provided"):
            raise ValueError("Invalid photo status.")
        return self
