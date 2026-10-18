"""Validated configuration, read from the environment (the root .env locally).

Loaded lazily (`get_settings()`), so tools that only import the app, like the OpenAPI
export, don't need a full environment. A missing or malformed value stops the service
at its first use, with a readable message.

Four processes read it: the service and its worker (`Settings`), the Cloud Run indexer
(`IndexerSettings`, app/indexer.py), the Cloud Run clipper (`ClipperSettings`,
app/clipper.py) and the Cloud Run aligner (`AlignerSettings`, app/aligner.py), which have
no database, Redis or caller secret of their own. What indexing a short needs, in the
service or the indexer, is `GeminiSettings`; the aligner needs Gemini too.
"""

from functools import lru_cache
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.schemas import MAX_ALIGN_TOKENS, MAX_PLAN_TOKENS

# A URL's origin and nothing after it: the indexer's URL is also the audience of the ID
# token the worker calls it with, which Cloud Run compares with the service's URL as is.
ORIGIN_PATTERN = r"^https?://[^/\s]+$"
GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"


class GeminiSettings(BaseSettings):
    """What indexing a short with Gemini needs, wherever it runs."""

    # An empty `KEY=` (as .env.example ships the optional ones) means unset.
    model_config = SettingsConfigDict(extra="ignore", env_ignore_empty=True)

    node_env: Literal["development", "test", "production"] = Field(
        default="development", alias="NODE_ENV"
    )
    log_level: Literal["debug", "info", "warning", "error"] = Field(
        default="info", alias="LOG_LEVEL"
    )
    release: str = Field(default="dev", alias="RELEASE")

    google_api_key: str | None = Field(default=None, min_length=1, alias="GOOGLE_API_KEY")
    # Another endpoint for the Gemini API: a gateway, or locally the mock Google
    # (packages/fake-google), which production refuses.
    google_base_url: AnyHttpUrl | None = Field(default=None, alias="GOOGLE_BASE_URL")
    # Gemini through Vertex AI instead of the Gemini API. With GOOGLE_API_KEY, express
    # mode (a Vertex key, bound to a service account); without one, Application Default
    # Credentials (the Cloud Run indexer's service account). Vertex bills through Cloud
    # Billing, so a project's Cloud credits pay for it; the Gemini API bills separately.
    # Defaults to true in .env.example so a key added later is billed through Vertex
    # without an extra step; true alone (no key yet) is harmless for the service, since
    # nothing calls Gemini without DIRECTOR_MODEL, which needs a key.
    google_vertex: bool = Field(default=False, alias="GOOGLE_VERTEX")
    # Required once GOOGLE_VERTEX is true and something calls Gemini: every call addresses
    # its model by the full resource name (app/director.py's create_google_model), which
    # needs the project (an API key otherwise drops it from the request). The same
    # variable apps/api reads for Director's live video call.
    google_cloud_project: str | None = Field(
        default=None, min_length=1, alias="GOOGLE_CLOUD_PROJECT"
    )
    # The Vertex location every Gemini call addresses its model at. Newer models
    # (gemini-4-argon) are served only from "global"; an API key routes a bare model name
    # to us-central1 regardless, which is why the resource name carries this instead.
    vertex_location: str = Field(default="global", min_length=1, alias="VERTEX_LOCATION")
    # Indexing (a plan job, never a live request) uses its own model: one picked for
    # watching an arbitrary short unattended, not the one DIRECTOR_MODEL names for the
    # scene checks and reviews a member waits on. INDEX_FALLBACK_MODEL stands in once a
    # plan's retries on INDEX_MODEL are all spent (app/indexing.py's index_short).
    index_model: str = Field(default="gemini-4-argon", min_length=1, alias="INDEX_MODEL")
    index_fallback_model: str = Field(
        default="gemini-3.1-pro-preview", min_length=1, alias="INDEX_FALLBACK_MODEL"
    )
    # The Cloud Storage bucket a short's original audio is captured into while it's
    # indexed (app/audio.py, `audio/<videoId>.m4a`), with Application Default Credentials;
    # the same bucket as apps/api's GCS_BUCKET, which signs links to it. Unset: no capture.
    media_bucket: str | None = Field(
        default=None, pattern=r"^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", alias="MEDIA_BUCKET"
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

    def _refuse_plain_http_indexer(self, indexer_url: str | None) -> None:
        if self.node_env == "production" and indexer_url and not indexer_url.startswith("https:"):
            raise ValueError("INDEXER_URL must be HTTPS in production")


class Settings(GeminiSettings):
    """The service (app/main.py) and its worker (app/worker.py)."""

    database_url: PostgresDsn = Field(alias="AI_DATABASE_URL")
    database_pool_max: int = Field(default=5, ge=1, le=100, alias="AI_DATABASE_POOL_MAX")
    redis_url: RedisDsn = Field(alias="REDIS_URL")

    # apps/api signs a short-lived token for every call (see app/auth.py).
    service_secret: str = Field(min_length=32, alias="AI_SERVICE_SECRET")

    # Budget: tokens a workspace may use per calendar month, across every model call.
    monthly_tokens_per_org: int = Field(default=2_000_000, ge=0, alias="AI_MONTHLY_TOKENS_PER_ORG")
    # A demo guest's workspace (apps/api/src/auth/guest.ts) gets this many at most: it
    # lasts a day, and the demo may have dozens at once.
    monthly_tokens_per_demo_guest: int = Field(
        default=300_000, ge=0, alias="AI_MONTHLY_TOKENS_PER_DEMO_GUEST"
    )

    # Director (app/director.py): the Gemini model that watches shorts and reviews takes, by
    # its Gemini API name ("gemini-3.5-flash"). Gemini, not any provider: it is the model
    # that watches a YouTube video from its URL. Unset: Director off. There is no local
    # stand-in, on purpose: a plan or a review that no model wrote would be made up.
    director_model: str | None = Field(default=None, min_length=1, alias="DIRECTOR_MODEL")
    # A plan watches the whole short (about 300 tokens a second) and thinks; a scene check
    # looks at one frame; a review watches one take.
    director_tokens_per_plan: int = Field(
        default=200_000, ge=10_000, le=MAX_PLAN_TOKENS, alias="DIRECTOR_TOKENS_PER_PLAN"
    )
    director_tokens_per_scene_check: int = Field(
        default=12_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_SCENE_CHECK"
    )
    director_tokens_per_review: int = Field(
        default=120_000, ge=10_000, alias="DIRECTOR_TOKENS_PER_REVIEW"
    )
    # Director's voice (app/speech.py): the Gemini text-to-speech model that reads a guide
    # line aloud on the shoot screen, by its short name, addressed like every other model
    # (VERTEX_LOCATION). On with Director. A line is bounded (MAX_SPEECH_TEXT), and so is
    # what it costs: about 25 tokens a second of speech, so a whole line of the longest
    # kind fits comfortably in the default.
    tts_model: str = Field(default="gemini-3.8-flash-tts", min_length=1, alias="TTS_MODEL")
    director_tokens_per_speech: int = Field(
        default=3_000, ge=1_000, alias="DIRECTOR_TOKENS_PER_SPEECH"
    )
    # Writing a cut's YouTube post reads its plan's text, no video.
    director_tokens_per_publish_copy: int = Field(
        default=20_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_PUBLISH_COPY"
    )
    # The default images of a plan's assets (app/assets.py): the Nano Banana model that
    # draws them, by its short name, addressed like every other model (VERTEX_LOCATION).
    # On with Director and MEDIA_BUCKET, where they're kept. A 1K image is about 1,300
    # output tokens with the model's thinking, and its prompt a few hundred.
    asset_model: str = Field(default="gemini-nano-banana-2.1", min_length=1, alias="ASSET_MODEL")
    director_tokens_per_asset: int = Field(
        default=6_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_ASSET"
    )
    # Re-planning the member's version (app/revise.py) reads the plan's text and their
    # version, no video.
    director_tokens_per_revise: int = Field(
        default=30_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_REVISE"
    )
    # Veo clips for the gaps of a member's video (app/clips.py), by its short name; empty
    # turns clips off (a gap's Create tab then draws stills). Each clip is counted against
    # the workspace's allowance as this many tokens, standing for its price by the second.
    veo_model: str = Field(default="veo-3.1-lite-generate-preview", alias="VEO_MODEL")
    director_tokens_per_clip: int = Field(
        default=60_000, ge=2_000, alias="DIRECTOR_TOKENS_PER_CLIP"
    )

    # Product analytics (app/analytics.py): plans indexed and take reviews, streamed into
    # this BigQuery dataset's `events` table in GOOGLE_CLOUD_PROJECT, the same table
    # apps/api writes to. A dataset name is letters, digits and underscores. Unset: off.
    bigquery_dataset: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_]{1,1024}$", alias="BIGQUERY_DATASET"
    )
    # The Cloud Run indexer (app/indexer.py), where plan jobs send their short to be
    # indexed, with an ID token for this URL from the metadata server. Unset: they're
    # indexed here in the worker, the same way.
    indexer_url: str | None = Field(default=None, pattern=ORIGIN_PATTERN, alias="INDEXER_URL")
    # The Cloud Run clipper (app/clipper.py), where recorded attempts are sent to be cut
    # into takes, with an ID token for this URL from the metadata server. Required in
    # production: a member's footage is never decoded in this service there, which holds
    # the secrets and the database. Unset elsewhere: they're cut here, the same way.
    clipper_url: str | None = Field(default=None, pattern=ORIGIN_PATTERN, alias="CLIPPER_URL")
    # Lining up a match cut (app/aligning.py) shows Gemini two frames, small.
    director_tokens_per_alignment: int = Field(
        default=12_000, ge=2_000, le=MAX_ALIGN_TOKENS, alias="DIRECTOR_TOKENS_PER_ALIGNMENT"
    )
    # The Cloud Run aligner (app/aligner.py), where match cuts are sent to be lined up,
    # with an ID token for this URL from the metadata server. Unset: they're lined up
    # here, in this service, the same way.
    aligner_url: str | None = Field(default=None, pattern=ORIGIN_PATTERN, alias="ALIGNER_URL")

    @model_validator(mode="after")
    def _indexer_is_https_in_production(self) -> Self:
        self._refuse_plain_http_indexer(self.indexer_url)
        if (
            self.node_env == "production"
            and self.aligner_url
            and not self.aligner_url.startswith("https:")
        ):
            raise ValueError("ALIGNER_URL must be HTTPS in production")
        return self

    @model_validator(mode="after")
    def _production_clips_on_cloud_run(self) -> Self:
        # Like the other local stand-ins, cutting in-process is refused in production:
        # ffmpeg reading member-supplied bytes belongs in the Cloud Run clipper's sandbox.
        if self.node_env != "production":
            return self
        if not self.clipper_url:
            raise ValueError("CLIPPER_URL is required in production")
        if not self.clipper_url.startswith("https:"):
            raise ValueError("CLIPPER_URL must be HTTPS in production")
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

    @model_validator(mode="after")
    def _analytics_has_a_project(self) -> Self:
        # A dataset with no project to find it in: fail at boot, not at every event.
        if self.bigquery_dataset and not self.google_cloud_project:
            raise ValueError("BIGQUERY_DATASET needs GOOGLE_CLOUD_PROJECT")
        return self


class IndexerSettings(GeminiSettings):
    """The Cloud Run indexer (app/indexer.py)."""

    # Its own URL (the worker's INDEXER_URL): the only audience the ID tokens it accepts
    # may name.
    indexer_url: str = Field(pattern=ORIGIN_PATTERN, alias="INDEXER_URL")
    # The one service account allowed to call it (the VM's, which the worker runs as):
    # Cloud Run's IAM already lets only invokers in, and the indexer checks again itself.
    indexer_invoker: str = Field(pattern=r"^[^@\s]+@[^@\s]+$", alias="INDEXER_INVOKER")
    # Where Google publishes the keys its ID tokens are signed with. Only tests point it
    # elsewhere (a local stand-in), which production refuses.
    google_certs_url: AnyHttpUrl = Field(
        default=AnyHttpUrl(GOOGLE_CERTS_URL), alias="GOOGLE_CERTS_URL"
    )

    @model_validator(mode="after")
    def _indexer_reaches_gemini_safely(self) -> Self:
        self._refuse_plain_http_indexer(self.indexer_url)
        if self.google_vertex and not self.google_cloud_project:
            raise ValueError("GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT")
        if not self.google_vertex and not self.google_api_key:
            raise ValueError("the indexer needs GOOGLE_API_KEY or GOOGLE_VERTEX=true")
        if self.node_env == "production" and self.google_certs_url.scheme != "https":
            raise ValueError("GOOGLE_CERTS_URL must be HTTPS in production")
        return self


class ClipperSettings(BaseSettings):
    """The Cloud Run clipper (app/clipper.py): no database, Redis, Gemini or storage of
    its own; the footage comes and goes by presigned reads."""

    model_config = SettingsConfigDict(extra="ignore", env_ignore_empty=True)

    node_env: Literal["development", "test", "production"] = Field(
        default="development", alias="NODE_ENV"
    )
    log_level: Literal["debug", "info", "warning", "error"] = Field(
        default="info", alias="LOG_LEVEL"
    )
    # Its own URL (the AI service's CLIPPER_URL): the only audience its callers' ID
    # tokens may name.
    clipper_url: str = Field(pattern=ORIGIN_PATTERN, alias="CLIPPER_URL")
    # The one service account allowed to call it (the VM's, which the AI service runs as).
    clipper_invoker: str = Field(pattern=r"^[^@\s]+@[^@\s]+$", alias="CLIPPER_INVOKER")
    # Where Google publishes the keys its ID tokens are signed with; only tests point it
    # elsewhere, which production refuses.
    google_certs_url: AnyHttpUrl = Field(
        default=AnyHttpUrl(GOOGLE_CERTS_URL), alias="GOOGLE_CERTS_URL"
    )

    @model_validator(mode="after")
    def _https_in_production(self) -> Self:
        if self.node_env == "production" and (
            not self.clipper_url.startswith("https:") or self.google_certs_url.scheme != "https"
        ):
            raise ValueError("CLIPPER_URL and GOOGLE_CERTS_URL must be HTTPS in production")
        return self


class AlignerSettings(GeminiSettings):
    """The Cloud Run aligner (app/aligner.py): no database, Redis or storage of its own;
    the takes come by presigned reads, and the service counts what it used."""

    # The model that locates the anchor: the service's DIRECTOR_MODEL.
    director_model: str = Field(min_length=1, alias="DIRECTOR_MODEL")
    # Its own URL (the service's ALIGNER_URL): the only audience its callers' ID tokens
    # may name.
    aligner_url: str = Field(pattern=ORIGIN_PATTERN, alias="ALIGNER_URL")
    # The one service account allowed to call it (the VM's, which the service runs as).
    aligner_invoker: str = Field(pattern=r"^[^@\s]+@[^@\s]+$", alias="ALIGNER_INVOKER")
    # Where Google publishes the keys its ID tokens are signed with; only tests point it
    # elsewhere, which production refuses.
    google_certs_url: AnyHttpUrl = Field(
        default=AnyHttpUrl(GOOGLE_CERTS_URL), alias="GOOGLE_CERTS_URL"
    )

    @model_validator(mode="after")
    def _aligner_reaches_gemini_safely(self) -> Self:
        if self.google_vertex and not self.google_cloud_project:
            raise ValueError("GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT")
        if not self.google_vertex and not self.google_api_key:
            raise ValueError("the aligner needs GOOGLE_API_KEY or GOOGLE_VERTEX=true")
        if self.node_env == "production" and (
            not self.aligner_url.startswith("https:") or self.google_certs_url.scheme != "https"
        ):
            raise ValueError("ALIGNER_URL and GOOGLE_CERTS_URL must be HTTPS in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]  # values come from the environment


@lru_cache
def get_indexer_settings() -> IndexerSettings:
    return IndexerSettings()  # pyright: ignore[reportCallIssue]  # values come from the environment


@lru_cache
def get_clipper_settings() -> ClipperSettings:
    return ClipperSettings()  # pyright: ignore[reportCallIssue]  # values come from the environment


@lru_cache
def get_aligner_settings() -> AlignerSettings:
    return AlignerSettings()  # pyright: ignore[reportCallIssue]  # values come from the environment
