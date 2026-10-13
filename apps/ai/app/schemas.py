"""Request/response models.

These Pydantic models are the contract with the TypeScript side. FastAPI turns them
into `openapi.json`, which `packages/ai-client` turns into TypeScript types. So a field
you add here shows up, typed, in `apps/api` after `bun run gen`.

Constrain every field (lengths, ranges, enums). The constraints are enforced at
runtime by Pydantic *and* end up in the OpenAPI schema as documentation. Requests are
strict: only apps/api calls this service, through the generated client, so a field it
doesn't know or a value of the wrong type is a bug on one side, refused rather than
coerced or dropped.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# For every request model (see above).
REQUEST = ConfigDict(strict=True, extra="forbid")


class SentimentRequest(BaseModel):
    model_config = REQUEST

    text: str = Field(min_length=1, max_length=5_000, description="Text to classify.")


class SentimentResponse(BaseModel):
    label: Literal["positive", "negative", "neutral"]
    score: float = Field(ge=0, le=1, description="Confidence of the predicted label.")
    model: str = Field(description="Identifier of the model that produced the prediction.")


class HealthResponse(BaseModel):
    status: Literal["ok"]


class DocumentCreate(BaseModel):
    model_config = REQUEST

    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=200_000, description="Plain text.")


# The database checks it too (document_status_check).
DocumentStatus = Literal["pending", "indexing", "ready", "failed"]


class DocumentOut(BaseModel):
    id: UUID
    title: str
    status: DocumentStatus
    error: str | None
    chunkCount: int
    summary: str | None
    createdBy: UUID | None
    createdAt: datetime
