"""Database access for the ai schema, always scoped to one organization.

`tenant(org_id)` opens a transaction with app.org_id set, so row-level security limits
every statement to that organization; there is no unscoped session. The engine is
created once per process (`open_engine` in the app's lifespan and the worker).
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from uuid import UUID

from pydantic import PostgresDsn
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

_engine: AsyncEngine | None = None
_sessions: async_sessionmaker[AsyncSession] | None = None


def _async_url(url: PostgresDsn) -> str:
    return (
        str(url)
        .replace("postgresql://", "postgresql+psycopg://", 1)
        .replace("postgres://", "postgresql+psycopg://", 1)
    )


def open_engine(url: PostgresDsn, pool_max: int) -> AsyncEngine:
    global _engine, _sessions
    _engine = create_async_engine(
        _async_url(url),
        pool_size=pool_max,
        max_overflow=0,
        pool_pre_ping=True,
        connect_args={"application_name": "ai"},
    )
    _sessions = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def close_engine() -> None:
    global _engine, _sessions
    if _engine:
        await _engine.dispose()
    _engine, _sessions = None, None


def engine() -> AsyncEngine:
    if not _engine:
        raise RuntimeError("the database engine isn't open (open_engine at startup)")
    return _engine


@asynccontextmanager
async def tenant(org_id: UUID) -> AsyncGenerator[AsyncSession]:
    """A transaction limited to one organization's rows; committed on success."""
    if not _sessions:
        raise RuntimeError("the database engine isn't open (open_engine at startup)")
    async with _sessions() as session, session.begin():
        await session.execute(
            text("SELECT set_config('app.org_id', :org, true)"), {"org": str(org_id)}
        )
        yield session
