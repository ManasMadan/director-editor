"""Validated configuration, read from the environment (the root .env locally).

Loaded lazily (`get_settings()`), so tools that only import the app, like the OpenAPI
export, don't need a full environment. A missing or malformed value stops the service
at its first use, with a readable message.
"""

from functools import lru_cache
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # An empty `KEY=` (as .env.example ships the optional ones) means unset.
    model_config = SettingsConfigDict(extra="ignore", env_ignore_empty=True)

    node_env: Literal["development", "test", "production"] = Field(
        default="development", alias="NODE_ENV"
    )
    log_level: Literal["debug", "info", "warning", "error"] = Field(
        default="info", alias="LOG_LEVEL"
    )
    release: str = Field(default="dev", alias="RELEASE")

    database_url: PostgresDsn = Field(alias="AI_DATABASE_URL")
    database_pool_max: int = Field(default=5, ge=1, le=100, alias="AI_DATABASE_POOL_MAX")
    redis_url: RedisDsn = Field(alias="REDIS_URL")

    # apps/api signs a short-lived token for every call (see app/auth.py).
    service_secret: str = Field(min_length=32, alias="AI_SERVICE_SECRET")

    # Budget: tokens a workspace may use per calendar month, across every model call.
    monthly_tokens_per_org: int = Field(default=2_000_000, ge=0, alias="AI_MONTHLY_TOKENS_PER_ORG")

    # Director (app/director.py): the Gemini model that watches shorts and reviews takes, by
    # its Gemini API name ("gemini-3.5-flash"). Gemini, not any provider: it is the model
    # that watches a YouTube video from its URL. Unset: Director off. There is no local
    # stand-in, on purpose: a plan or a review that no model wrote would be made up.
    director_model: str | None = Field(default=None, min_length=1, alias="DIRECTOR_MODEL")
    google_api_key: str | None = Field(default=None, min_length=1, alias="GOOGLE_API_KEY")
    # Another endpoint for the Gemini API: a gateway, or locally the mock Google
    # (packages/fake-google), which production refuses.
    google_base_url: AnyHttpUrl | None = Field(default=None, alias="GOOGLE_BASE_URL")
    # Gemini through Vertex AI (express mode: GOOGLE_API_KEY is a Vertex key, bound to a
    # service account) instead of the Gemini API. Vertex bills through Cloud Billing, so a
    # project's Cloud credits pay for it; the Gemini API bills separately. Defaults to true
    # in .env.example so a key added later is billed through Vertex without an extra step;
    # true alone (no key yet) is harmless, since nothing calls Gemini without one.
    google_vertex: bool = Field(default=False, alias="GOOGLE_VERTEX")
    # Required once GOOGLE_VERTEX is true and a key turns it on: an API key drops the
    # project/location from the request unless every call addresses its model by the full
    # resource name (app/director.py's create_google_model), which needs the project. The
    # same variable apps/api reads for Director's live video call.
    google_cloud_project: str | None = Field(
        default=None, min_length=1, alias="GOOGLE_CLOUD_PROJECT"
    )
    # The Vertex location every Gemini call addresses its model at. Newer models
    # (gemini-4-argon) are served only from "global"; an API key routes a bare model name
    # to us-central1 regardless, which is why the resource name carries this instead.
    vertex_location: str = Field(default="global", min_length=1, alias="VERTEX_LOCATION")
    # A plan watches the whole short (about 300 tokens a second) and thinks; a scene check
    # looks at one frame; a review watches one take.
    director_tokens_per_plan: int = Field(
        default=200_000, ge=10_000, alias="DIRECTOR_TOKENS_PER_PLAN"
    )
    director_tokens_per_scene_check: int = Field(
        default=12_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_SCENE_CHECK"
    )
    director_tokens_per_review: int = Field(
        default=120_000, ge=10_000, alias="DIRECTOR_TOKENS_PER_REVIEW"
    )
    # Indexing (a plan job, never a live request) uses its own model: one picked for
    # watching an arbitrary short unattended, not the one DIRECTOR_MODEL names for the
    # scene checks and reviews a member waits on. INDEX_FALLBACK_MODEL stands in once a
    # plan's retries on INDEX_MODEL are all spent (see app/director.py's retry loop).
    index_model: str = Field(default="gemini-4-argon", min_length=1, alias="INDEX_MODEL")
    index_fallback_model: str = Field(
        default="gemini-3.1-pro-preview", min_length=1, alias="INDEX_FALLBACK_MODEL"
    )

    @model_validator(mode="after")
    def _production_uses_real_providers(self) -> Self:
        if (
            self.node_env == "production"
            and self.google_base_url
            and self.google_base_url.scheme != "https"
        ):
            raise ValueError("GOOGLE_BASE_URL must be HTTPS in production")
        return self

    @model_validator(mode="after")
    def _director_has_a_key(self) -> Self:
        # Half-configured fails at boot, not at the first plan.
        if self.director_model and not self.google_api_key:
            raise ValueError("DIRECTOR_MODEL needs GOOGLE_API_KEY")
        return self

    @model_validator(mode="after")
    def _vertex_has_a_project(self) -> Self:
        # Without it, create_google_model can't address a model by its resource name. Only
        # once a key actually turns Vertex on: GOOGLE_VERTEX=true with no GOOGLE_API_KEY
        # yet (.env.example's default) must still boot.
        if self.google_vertex and self.google_api_key and not self.google_cloud_project:
            raise ValueError("GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]  # values come from the environment
