"""Live-update nudges, in the same format the TypeScript services publish (see
packages/nest-common realtime): Redis pub/sub on the organization's channel, with a
message from the shared contract. Both the message models and the channel's Redis name
are generated from packages/contracts (app/contracts)."""

from pathlib import Path
from uuid import UUID

from pydantic import BaseModel
from redis.asyncio import Redis

from app.contracts.realtime_message import RealtimeMessage


class _Channels(BaseModel):
    # The organization's channel, with `{id}` where its id goes.
    org: str


_CHANNELS = _Channels.model_validate_json(
    (Path(__file__).parent / "contracts" / "realtime_channels.json").read_bytes()
)


def org_channel(org_id: UUID) -> str:
    return _CHANNELS.org.replace("{id}", str(org_id))


async def publish_to_org(redis: Redis, org_id: UUID, message: RealtimeMessage) -> None:
    channel, data = org_channel(org_id), message.model_dump_json()
    await redis.publish(channel, data)  # pyright: ignore[reportUnknownMemberType]  # untyped options
