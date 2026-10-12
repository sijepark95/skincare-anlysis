"""Versioned integrated observations. No prose, scores, demographics or recommendation outputs."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from senmiva_analysis.domain.beauty import BeautyObservation, BeautyAnalysisResponse, MODEL

PROMPT_VERSION = "beauty-complete-v1"
ANIMAL_VIBES = ("cat", "dog", "rabbit", "fox", "deer", "bear", "uncertain")
BASE_DEPTHS = ("fair", "light", "medium", "tan", "deep", "uncertain")
SKIN_FEATURES = ("visible_redness", "visible_spots", "visible_pores", "visible_fine_lines", "visible_flaking")


class SkinObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image_quality: Literal["usable", "limited", "not_assessable"]
    quality_flags: list[Literal["no_face", "multiple_faces", "blur", "low_light", "uneven_lighting", "occlusion",
                               "makeup_or_filter", "face_not_fully_visible", "resolution_limited"]] = Field(max_length=9)
    observed_features: dict[str, Literal["visible", "not_visible", "uncertain", "not_assessable"]]

    @model_validator(mode="after")
    def correlated_quality(self):
        if (set(self.observed_features) != set(SKIN_FEATURES) or
            len(set(self.quality_flags)) != len(self.quality_flags) or
            (self.image_quality == "usable" and self.quality_flags) or
            (self.image_quality != "usable" and not self.quality_flags) or
            (self.image_quality == "not_assessable" and any(value != "not_assessable" for value in self.observed_features.values())) or
            (any(flag in self.quality_flags for flag in ("no_face", "multiple_faces")) and self.image_quality != "not_assessable")):
            raise ValueError("Invalid skin observation quality.")
        return self


class SkinVision(SkinObservation):
    prompt_version: Literal["visible-appearance-eval-v1"]


class CompleteObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    beauty: BeautyObservation
    skin: SkinObservation
    animalVibe: Literal["cat", "dog", "rabbit", "fox", "deer", "bear", "uncertain"]
    baseDepth: Literal["fair", "light", "medium", "tan", "deep", "uncertain"]

    @model_validator(mode="after")
    def cosmetic_uncertainty(self):
        if self.beauty.image_quality != "usable" and (self.animalVibe != "uncertain" or self.baseDepth != "uncertain"):
            raise ValueError("Limited photo cannot establish a styling direction.")
        return self


class BeautyCompleteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    mode: Literal["openai_beauty_complete"]
    model_version: Literal["gpt-4.1-mini-2025-04-14"]
    prompt_version: Literal["beauty-complete-v1"]
    beauty: BeautyAnalysisResponse
    skin: SkinVision
    animalVibe: Literal["cat", "dog", "rabbit", "fox", "deer", "bear", "uncertain"]
    baseDepth: Literal["fair", "light", "medium", "tan", "deep", "uncertain"]

    @model_validator(mode="after")
    def correlated_result(self):
        if self.request_id != self.beauty.request_id or self.model_version != MODEL:
            raise ValueError("Invalid integrated observation correlation.")
        if self.beauty.image_quality != "usable" and (self.animalVibe != "uncertain" or self.baseDepth != "uncertain"):
            raise ValueError("Invalid integrated observation quality.")
        return self
