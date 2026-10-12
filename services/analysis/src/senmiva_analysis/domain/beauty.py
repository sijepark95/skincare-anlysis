"""Bounded cosmetic style observations, independent of skin and colour protocols."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL = "gpt-4.1-mini-2025-04-14"
PROMPT_VERSION = "beauty-style-suggestion-v2"
UNDERTONES = ("warm", "cool", "neutral", "uncertain")
CHROMAS = ("soft", "clear", "uncertain")
FACE_SHAPES = ("oval", "round", "square", "oblong", "heart", "diamond", "uncertain")
EYE_SHAPES = ("almond", "round", "hooded", "monolid", "uncertain")
NOSE_SHAPES = ("slender", "medium", "broad", "uncertain")
LIP_FULLNESSES = ("fine", "medium", "full", "uncertain")
QUALITIES = ("usable", "limited", "not_assessable")
QUALITY_FLAGS = ("no_face", "multiple_faces", "blur", "low_light", "uneven_lighting",
                 "makeup_or_filter", "face_not_fully_visible", "resolution_limited")


class BeautyObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image_quality: Literal["usable", "limited", "not_assessable"]
    undertone: Literal["warm", "cool", "neutral", "uncertain"]
    chroma: Literal["soft", "clear", "uncertain"]
    face_shape: Literal["oval", "round", "square", "oblong", "heart", "diamond", "uncertain"]
    eye_shape: Literal["almond", "round", "hooded", "monolid", "uncertain"]
    nose_shape: Literal["slender", "medium", "broad", "uncertain"]
    lip_fullness: Literal["fine", "medium", "full", "uncertain"]
    quality_flags: list[Literal["no_face", "multiple_faces", "blur", "low_light", "uneven_lighting",
                               "makeup_or_filter", "face_not_fully_visible", "resolution_limited"]] = Field(max_length=8)

    @model_validator(mode="after")
    def correlated_quality(self):
        if (len(set(self.quality_flags)) != len(self.quality_flags) or
            (self.image_quality == "usable" and self.quality_flags) or
            (self.image_quality != "usable" and
             (not self.quality_flags or any(value != "uncertain" for value in
              (self.undertone, self.chroma, self.face_shape, self.eye_shape, self.nose_shape, self.lip_fullness)))) or
            (any(flag in self.quality_flags for flag in ("no_face", "multiple_faces")) and self.image_quality != "not_assessable")):
            raise ValueError("Invalid beauty suggestion quality.")
        return self


class BeautyAnalysisResponse(BeautyObservation):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    mode: Literal["openai_beauty"]
    model_version: Literal["gpt-4.1-mini-2025-04-14"]
    prompt_version: Literal["beauty-style-suggestion-v2"]
