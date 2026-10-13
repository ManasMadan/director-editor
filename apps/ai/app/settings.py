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
    model_config = SettingsConfigDict(extra="ignore")

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

    # The assistant's model, as a Pydantic AI model name ("anthropic:claude-sonnet-5",
    # "openai:gpt-5"), with an optional fallback when it fails. Unset: assistant off.
    # "local:extractive" answers from the retrieved passages without any model: for
    # development and tests only.
    model: str | None = Field(default=None, alias="AI_MODEL")
    fallback_model: str | None = Field(default=None, alias="AI_FALLBACK_MODEL")
    # The embedding model, as a Pydantic AI name ("openai:text-embedding-3-small"), or
    # "hashing" (local and lexical: development and tests only). Must give 1536 dimensions.
    embeddings: str = Field(default="hashing", min_length=1, alias="AI_EMBEDDINGS")
    # Cosine similarity below which a passage isn't relevant to a question (provider
    # embeddings only; see app/embeddings.py). Calibrate with `bun run --cwd apps/ai evals`.
    min_relevance: float = Field(default=0.0, ge=0.0, lt=1.0, alias="AI_MIN_RELEVANCE")

    # The MCP server (app/mcp_server.py): the site's public origin, where it and apps/api's
    # OAuth issuer live (the same BETTER_AUTH_URL as the api), and the api's internal URL,
    # for its signing keys. Either unset: no MCP server.
    site_url: AnyHttpUrl | None = Field(default=None, alias="BETTER_AUTH_URL")
    api_url: AnyHttpUrl | None = Field(default=None, alias="API_URL")

    # Budgets: tokens a workspace may use per calendar month, and per assistant answer.
    monthly_tokens_per_org: int = Field(default=2_000_000, ge=0, alias="AI_MONTHLY_TOKENS_PER_ORG")
    tokens_per_run: int = Field(default=20_000, ge=1_000, alias="AI_TOKENS_PER_RUN")

    @model_validator(mode="after")
    def _production_uses_real_providers(self) -> Self:
        if self.node_env == "production":
            if self.embeddings == "hashing":
                raise ValueError("AI_EMBEDDINGS=hashing is for development only")
            for name in (self.model, self.fallback_model):
                if name and name.startswith("local:"):
                    raise ValueError(f"AI_MODEL={name} is for development only")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]  # values come from the environment
