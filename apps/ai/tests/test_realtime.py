"""Realtime nudges go where the TypeScript services listen (packages/contracts realtime)."""

from uuid import uuid4

from app.realtime import org_channel


def test_an_organization_s_channel_is_the_one_the_api_subscribes_to() -> None:
    org = uuid4()
    # REALTIME_REDIS_PREFIX + realtimeChannel.org(orgId) in packages/contracts.
    assert org_channel(org) == f"realtime:org:{org}"
