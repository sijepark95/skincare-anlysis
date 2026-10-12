from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from senmiva_analysis.api.contracts import MAX_BASE64_CHARACTERS


class ColorPhotoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    image_base64: str = Field(min_length=4, max_length=MAX_BASE64_CHARACTERS, strict=True)
