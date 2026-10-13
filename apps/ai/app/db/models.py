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

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.schemas import DocumentStatus, PlanStatus, TakeKind, TakeStatus

EMBEDDING_DIMENSIONS = 1536


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


class Document(Base):
    __tablename__ = "document"
    __table_args__: TableArgs = (
        Index("document_org_id_created_at_idx", "org_id", "created_at"),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(Text)
    # The text as added, kept so the document can be re-indexed.
    content: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    status: Mapped[DocumentStatus] = mapped_column(Text, server_default=text("'pending'::text"))
    error: Mapped[str | None] = mapped_column(Text)
    chunk_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))

    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="document", passive_deletes=True
    )


class DocumentChunk(Base):
    __tablename__ = "chunk"
    __table_args__: TableArgs = (
        Index("chunk_document_id_ordinal_key", "document_id", "ordinal", unique=True),
        Index("chunk_org_id_idx", "org_id"),
        Index(
            "chunk_embedding_idx",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai.document.id", ondelete="CASCADE", onupdate="CASCADE"),
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    ordinal: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIMENSIONS))

    document: Mapped[Document] = relationship(back_populates="chunks")


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


class DirectorPlan(Base):
    __tablename__ = "director_plan"
    __table_args__: TableArgs = (
        Index("director_plan_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_plan_org_id_video_id_key", "org_id", "video_id", unique=True),
        {"schema": "ai"},
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    video_id: Mapped[str] = mapped_column(Text)
    status: Mapped[PlanStatus] = mapped_column(Text, server_default=text("'pending'::text"))
    error: Mapped[str | None] = mapped_column(Text)
    # The ShotPlan as JSON (app/schemas.py); parsed back with its model when read.
    plan: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))


class DirectorTake(Base):
    __tablename__ = "director_take"
    __table_args__: TableArgs = (
        Index("director_take_org_id_id_idx", "org_id", text("id DESC")),
        Index("director_take_plan_id_user_id_shot_index_idx", "plan_id", "user_id", "shot_index"),
        Index("director_take_user_id_idx", "user_id"),
        Index("director_take_file_id_idx", "file_id"),
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
    created_at: Mapped[datetime.datetime] = _now()
    updated_at: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(timezone=True, precision=3))
