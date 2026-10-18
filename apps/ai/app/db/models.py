"""The ai schema, as typed SQLAlchemy models.

Prisma owns the DDL (packages/db/prisma/schema/ai.prisma and its migrations); these
models describe the same tables, and tests/test_models_match_db.py fails if they drift
from the migrated database. Foreign keys to other schemas (auth.organization,
auth.user) exist in the database but aren't modelled: this service never reads those
tables.

They're written by hand rather than generated with sqlacodegen because generating them
from the database follows those foreign keys and drags the auth tables in as models,
which this service must not have; the drift test gives the same guarantee a generator
would.
"""

import datetime
import uuid

from sqlalchemy import BigInteger, Date, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.schemas import (
    AssetImageStatus,
    AssetOrigin,
    AudioStatus,
    PlanSource,
    PlanStage,
    PlanStatus,
    PublishStatus,
    TakeKind,
    TakeOrigin,
    TakeStatus,
    Visibility,
)


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("uuidv7()"))


def _now() -> Mapped[datetime.datetime]:
    return mapped_column(
        TIMESTAMP(timezone=True, precision=3), server_default=text("CURRENT_TIMESTAMP")
    )


# SQLAlchemy declares __table_args__ as Any; these are indexes and the schema.
type TableArgs = tuple[Index | dict[str, str], ...]


class AiUsage(Base):
    __tablename__ = "usage"
    __table_args__: TableArgs = (
        Index("usage_org_id_created_at_idx", "org_id", "created_at"),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    feature: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer)
    output_tokens: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime.datetime] = _now()


class AiDemoUsage(Base):
    """What deleted demo guests spent, by month, feature and model. Written only by the
    guests' purge (auth.purge_expired_guests); this service never reads or writes it."""

    __tablename__ = "demo_usage"
    __table_args__: TableArgs = ({"schema": "ai"},)

    month: Mapped[datetime.date] = mapped_column(Date, primary_key=True)
    feature: Mapped[str] = mapped_column(Text, primary_key=True)
    model: Mapped[str] = mapped_column(Text, primary_key=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))


class DirectorPlan(Base):
    __tablename__ = "director_plan"
    __table_args__: TableArgs = (
        Index("director_plan_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_plan_org_id_video_id_key", "org_id", "video_id", unique=True),
        # A member's one short of their own (app/director.py's index).
        Index(
            "director_plan_one_user_index",
            "created_by",
            unique=True,
            postgresql_where=text("source = 'user'::text AND status <> 'failed'::text"),
        ),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    video_id: Mapped[str] = mapped_column(Text)
    source: Mapped[PlanSource] = mapped_column(Text, server_default=text("'user'::text"))
    # A created plan's brief (app/create.py's Brief, as JSON); None for every other plan.
    brief: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    status: Mapped[PlanStatus] = mapped_column(Text, server_default=text("'pending'::text"))
    stage: Mapped[PlanStage] = mapped_column(Text, server_default=text("'queued'::text"))
    error: Mapped[str | None] = mapped_column(Text)
    # The ShotPlan as JSON (app/schemas.py); parsed back with its model when read.
    plan: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(Text)
    audio_status: Mapped[AudioStatus] = mapped_column(Text, server_default=text("'none'::text"))
    audio_key: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))


class DirectorTake(Base):
    __tablename__ = "director_take"
    __table_args__: TableArgs = (
        Index("director_take_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_take_plan_id_user_id_shot_index_idx", "plan_id", "user_id", "shot_index"),
        Index("director_take_user_id_idx", "user_id"),
        Index("director_take_file_id_idx", "file_id"),
        Index("director_take_one_per_file", "file_id", unique=True),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.director_plan.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    shot_index: Mapped[int] = mapped_column(Integer)
    file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[TakeKind] = mapped_column(Text)
    status: Mapped[TakeStatus] = mapped_column(Text, server_default=text("'pending'::text"))
    error: Mapped[str | None] = mapped_column(Text)
    best_start_ms: Mapped[int | None] = mapped_column(Integer)
    best_end_ms: Mapped[int | None] = mapped_column(Integer)
    score: Mapped[int | None] = mapped_column(Integer)
    feedback: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    chosen_at: Mapped[datetime.datetime | None] = mapped_column(
        TIMESTAMP(timezone=True, precision=3)
    )
    origin: Mapped[TakeOrigin] = mapped_column(Text, server_default=text("'shoot'::text"))
    # app/schemas.py TakeIndex, as JSON: what the editor finds a take by.
    take_index: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))


class DirectorAsset(Base):
    __tablename__ = "director_asset"
    __table_args__: TableArgs = (
        Index("director_asset_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_asset_plan_id_idx", "plan_id"),
        Index("director_asset_user_id_created_at_idx", "user_id", "created_at"),
        # One default image per asset of a plan (app/assets.py).
        Index(
            "director_asset_one_default",
            "plan_id",
            "asset_id",
            unique=True,
            postgresql_where=text("origin = 'default'::text"),
        ),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.director_plan.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    asset_id: Mapped[str] = mapped_column(Text)
    origin: Mapped[AssetOrigin] = mapped_column(Text, server_default=text("'default'::text"))
    status: Mapped[AssetImageStatus] = mapped_column(Text, server_default=text("'pending'::text"))
    object_key: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    prompt: Mapped[str | None] = mapped_column(Text)
    reference_key: Mapped[str | None] = mapped_column(Text)
    base_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    credit: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))


class DirectorAssetChoice(Base):
    __tablename__ = "director_asset_choice"
    __table_args__: TableArgs = (
        Index(
            "director_asset_choice_plan_id_user_id_asset_id_id_idx",
            "plan_id",
            "user_id",
            "asset_id",
            text("id DESC"),
        ),
        Index("director_asset_choice_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_asset_choice_user_id_idx", "user_id"),
        Index("director_asset_choice_candidate_id_idx", "candidate_id"),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.director_plan.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    asset_id: Mapped[str] = mapped_column(Text)
    candidate_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.director_asset.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    created_at: Mapped[datetime.datetime] = _now()


class DirectorCut(Base):
    __tablename__ = "director_cut"
    __table_args__: TableArgs = (
        Index("director_cut_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_cut_plan_id_user_id_idx", "plan_id", "user_id"),
        Index("director_cut_user_id_idx", "user_id"),
        Index("director_cut_file_id_idx", "file_id"),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.director_plan.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(Text)
    # [{shotIndex, takeId}] (app/schemas.py CutPick); parsed back with its model when read.
    picks: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    duration_ms: Mapped[int] = mapped_column(Integer)
    publish_status: Mapped[PublishStatus] = mapped_column(Text, server_default=text("'none'::text"))
    youtube_video_id: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[Visibility | None] = mapped_column(Text)
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))
