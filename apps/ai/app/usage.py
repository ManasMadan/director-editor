"""Token budgets and the usage ledger (ai.usage), shared by every feature that calls a
model.

Before the work, `reserve` takes what a run may spend out of the workspace's monthly
allowance, atomically, so concurrent runs can't all fit into the same remainder; the run
is then capped at what was reserved. After it, whatever happened (an answer, the run
limit, a failure, a client that went away), `settle` records what the run actually used.

The ledger is append-only for this service (it may insert, never update), so a
reservation is a row for the reserved tokens and settling adds the difference to what
was used; the month's sum is what counts. A run that never settles (the process died)
keeps its reservation: that errs on the side of the budget.
"""

import datetime
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiUsage
from app.db.session import tenant

type Feature = Literal["assistant", "summary"]


@dataclass(frozen=True)
class Reservation:
    org_id: UUID
    user_id: UUID | None
    feature: Feature
    model: str
    tokens: int


async def _used_this_month(session: AsyncSession, org_id: UUID) -> int:
    month = datetime.datetime.now(datetime.UTC).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    used = await session.scalar(
        select(func.coalesce(func.sum(AiUsage.input_tokens + AiUsage.output_tokens), 0)).where(
            AiUsage.org_id == org_id, AiUsage.created_at >= month
        )
    )
    return int(used or 0)


async def reserve(
    org_id: UUID,
    user_id: UUID | None,
    feature: Feature,
    model: str,
    *,
    most: int,
    monthly: int,
) -> Reservation | None:
    """Up to `most` tokens of what's left of the month's allowance; None when nothing is."""
    async with tenant(org_id) as session:
        # One reservation per workspace at a time. The transaction-scoped lock is released
        # at commit, and unlike the session-scoped one it's safe behind a pooler.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"ai.usage:{org_id}"},
        )
        left = monthly - await _used_this_month(session, org_id)
        if left <= 0:
            return None
        reservation = Reservation(org_id, user_id, feature, model, min(most, left))
        session.add(_row(reservation, reservation.tokens, 0))
    return reservation


async def settle(reservation: Reservation, input_tokens: int, output_tokens: int) -> None:
    """Records what the run used, in place of what it reserved."""
    async with tenant(reservation.org_id) as session:
        session.add(_row(reservation, input_tokens - reservation.tokens, output_tokens))


def _row(reservation: Reservation, input_tokens: int, output_tokens: int) -> AiUsage:
    return AiUsage(
        org_id=reservation.org_id,
        user_id=reservation.user_id,
        feature=reservation.feature,
        model=reservation.model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )
