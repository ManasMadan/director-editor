"""The SQLAlchemy models match the migrated database (Prisma owns the DDL).

Reflects the ai schema and compares it with the models' metadata the way Alembic's
autogenerate does; any difference (a column, type, nullability, index or constraint)
fails, so a migration can't silently leave the models behind. Foreign keys into other
schemas exist only in the database and are skipped.
"""

import os

import pytest
from alembic.autogenerate import produce_migrations, render_python_code
from alembic.migration import MigrationContext
from sqlalchemy import ForeignKeyConstraint, Table, create_engine

from app.db.models import Base

pytestmark = pytest.mark.integration


def _include(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object
) -> bool:
    # Alembic hands over schema items untyped.
    if isinstance(obj, Table):
        return obj.schema == "ai"
    if isinstance(obj, ForeignKeyConstraint):
        return obj.referred_table.schema == "ai"
    return True


def test_models_match_the_migrated_database() -> None:
    url = os.environ["AI_DATABASE_URL"].replace("postgresql://", "postgresql+psycopg://", 1)
    engine = create_engine(url)
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={
                "include_schemas": True,
                "include_object": _include,
                "compare_type": True,
                "compare_server_default": True,
            },
        )
        migration = produce_migrations(context, Base.metadata).upgrade_ops
    engine.dispose()
    assert migration is not None
    assert migration.is_empty(), render_python_code(migration)
