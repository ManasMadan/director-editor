"""Token budgets against the real ledger (ai.usage): reservations keep concurrent runs
inside the monthly allowance, and a run gets only what is left of it. How each of
Director's calls settles what it spent is tested in tests/test_director.py."""

import asyncio
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.usage import Allowance, reserve, settle
from tests.support import as_org, migrator, new_org, on_app_loop

pytestmark = pytest.mark.integration

MONTHLY = 2_000_000
ALLOWANCE = Allowance(MONTHLY, 300_000)


def spent(org: UUID) -> int:
    [(total,)] = as_org(
        org, "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage", ()
    )
    assert isinstance(total, int)
    return total


def test_a_run_may_spend_only_what_is_left_of_the_month(client: TestClient) -> None:
    org, user = new_org()
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', %s, 0)",
        (org, MONTHLY - 20),
    )

    async def twice() -> tuple[int | None, int | None]:
        first = await reserve(org, user, "director-plan", "m", most=20_000, allowance=ALLOWANCE)
        second = await reserve(org, user, "director-plan", "m", most=20_000, allowance=ALLOWANCE)
        return (first.tokens if first else None, second.tokens if second else None)

    assert on_app_loop(client, twice) == (20, None)


def test_settling_records_what_the_run_used_instead_of_what_it_reserved(
    client: TestClient,
) -> None:
    org, user = new_org()

    async def run() -> None:
        reservation = await reserve(
            org, user, "director-locate", "m", most=1_000, allowance=ALLOWANCE
        )
        assert reservation is not None
        await settle(reservation, 300, 50)

    on_app_loop(client, run)
    assert spent(org) == 350


def test_concurrent_reservations_share_the_allowance(client: TestClient) -> None:
    org, user = new_org()

    async def three_at_once() -> list[int | None]:
        async def one() -> int | None:
            reservation = await reserve(
                org, user, "director-plan", "m", most=20_000, allowance=Allowance(30_000, 30_000)
            )
            return reservation.tokens if reservation else None

        return list(await asyncio.gather(one(), one(), one()))

    granted = on_app_loop(client, three_at_once)
    assert sorted(granted, key=lambda tokens: tokens or 0) == [None, 10_000, 20_000]
    assert spent(org) == 30_000


def test_a_demo_guests_workspace_gets_the_smaller_allowance(client: TestClient) -> None:
    guest_org, guest = new_org()
    with migrator() as db:
        db.execute(
            "UPDATE auth.\"user\" SET demo = true, guest_until = now() + interval '1 day'"
            " WHERE id = %s",
            (guest,),
        )
        db.execute(
            "INSERT INTO auth.member (organization_id, user_id, role) VALUES (%s, %s, 'owner')",
            (guest_org, guest),
        )
    member_org, member = new_org()
    allowance = Allowance(monthly=50_000, demo_guest=1_000)

    async def both() -> tuple[int | None, int | None]:
        theirs = await reserve(
            guest_org, guest, "director-plan", "m", most=20_000, allowance=allowance
        )
        ours = await reserve(
            member_org, member, "director-plan", "m", most=20_000, allowance=allowance
        )
        return (theirs.tokens if theirs else None, ours.tokens if ours else None)

    try:
        assert on_app_loop(client, both) == (1_000, 20_000)
    finally:
        # These tests share one database: a guest left behind would one day be expired,
        # and the guests' purge lets the migrator read expired guests' usage.
        with migrator() as db:
            db.execute("DELETE FROM auth.organization WHERE id = %s", (guest_org,))
            db.execute('DELETE FROM auth."user" WHERE id = %s', (guest,))
