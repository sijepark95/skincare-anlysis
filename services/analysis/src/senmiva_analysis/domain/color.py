"""Fixed, nonclinical personal-colour suggestion protocol, independent of skin analysis."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL = "gpt-4.1-mini-2025-04-14"
PROMPT_VERSION = "personal-color-suggestion-v1"
UNDERTONES = ("warm", "cool", "neutral", "uncertain")
CHROMAS = ("soft", "clear", "uncertain")
QUALITIES = ("usable", "limited", "not_assessable")
QUALITY_FLAGS = ("no_face", "multiple_faces", "blur", "low_light", "uneven_lighting",
                 "makeup_or_filter", "face_not_fully_visible", "resolution_limited")


class ColorObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image_quality: Literal["usable", "limited", "not_assessable"]
    undertone: Literal["warm", "cool", "neutral", "uncertain"]
    chroma: Literal["soft", "clear", "uncertain"]
    quality_flags: list[Literal["no_face", "multiple_faces", "blur", "low_light", "uneven_lighting",
                               "makeup_or_filter", "face_not_fully_visible", "resolution_limited"]] = Field(max_length=8)

    @model_validator(mode="after")
    def correlated_quality(self):
        if (len(set(self.quality_flags)) != len(self.quality_flags) or
            (self.image_quality == "usable" and self.quality_flags) or
            (self.image_quality != "usable" and (not self.quality_flags or self.undertone != "uncertain" or self.chroma != "uncertain")) or
            (any(flag in self.quality_flags for flag in ("no_face", "multiple_faces")) and self.image_quality != "not_assessable")):
            raise ValueError("Invalid colour suggestion quality.")
        return self


class ColorAnalysisResponse(ColorObservation):
    # UUID parses transport strings, while colour fields remain exact allowlisted literals.
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    mode: Literal["openai_color"]
    model_version: Literal["gpt-4.1-mini-2025-04-14"]
    prompt_version: Literal["personal-color-suggestion-v1"]
