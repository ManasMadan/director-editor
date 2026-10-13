"""What the integration tests share: settings for the service under test, fixtures
written straight to the database (as the migrator), service tokens, and typed views of
the service's responses."""

import os
from collections.abc import Awaitable, Callable
from typing import LiteralString
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import httpx2 as httpx
import psycopg
import redis
from fastapi.testclient import TestClient
from pydantic import BaseModel, TypeAdapter
from redis.client import PubSub

from app.contracts.error_response import ErrorResponse
from app.schemas import DocumentOut
from tests.tokens import SECRET, service_token

# Its own Redis database (the TypeScript suites use 7-15; 0 is the dev stack).
REDIS_URL = urlunsplit(
    urlsplit(os.environ.get("REDIS_URL", "redis://localhost:56379"))._replace(path="/6")
)
ENV = {
    "REDIS_URL": REDIS_URL,
    "AI_SERVICE_SECRET": SECRET,
    "AI_MODEL": "local:extractive",
    "AI_EMBEDDINGS": "hashing",
    "AI_MONTHLY_TOKENS_PER_ORG": "2000000",
    "NODE_ENV": "test",
}


def migrator() -> psycopg.Connection:
    return psycopg.connect(os.environ["MIGRATOR_DATABASE_URL"], autocommit=True)


def as_org(
    org: UUID, query: LiteralString, params: tuple[object, ...] = ()
) -> list[tuple[object, ...]]:
    """A statement on ai tables, scoped to one organization (row-level security applies
    to every role, the migrator included)."""
    with migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.org_id', %s, true)", (str(org),))
        cursor = db.execute(query, params)
        return cursor.fetchall() if cursor.description else []


def new_org() -> tuple[UUID, UUID]:
    """An organization with one user, as apps/api would have created them."""
    org, user = uuid4(), uuid4()
    with migrator() as db:
        db.execute(
            "INSERT INTO auth.organization (id, name, slug) VALUES (%s, 'Org', %s)", (org, str(org))
        )
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (user, "U", f"{user}@test.dev"),
        )
    return org, user


def headers(org: UUID, user: UUID) -> dict[str, str]:
    return {"authorization": f"Bearer {service_token(user, org)}", "x-request-id": "req-test"}


def on_app_loop[T](client: TestClient, work: Callable[[], Awaitable[T]]) -> T:
    """Runs `work` on the app's own event loop, where its database engine lives."""
    portal = client.portal
    assert portal is not None, "only inside `with TestClient(app)`"
    return portal.call(work)


def index_all(client: TestClient, org: UUID) -> None:
    """What the worker does for each queued document, run in-process."""
    from app.main import services

    documents = services().documents
    for doc in documents_of(client.get("/v1/documents", headers=headers(org, uuid4()))):
        on_app_loop(client, lambda doc=doc: documents.index(org, doc.id))


def body(response: httpx.Response) -> object:
    """The whole JSON body, to compare with what it should be."""
    return _JSON.validate_json(response.content)


# Any JSON value: what a body or a message is compared with.
_JSON = TypeAdapter(object)


_DOCUMENTS = TypeAdapter(list[DocumentOut])


def documents_of(response: httpx.Response) -> list[DocumentOut]:
    return _DOCUMENTS.validate_json(response.content)


def document_of(response: httpx.Response) -> DocumentOut:
    return DocumentOut.model_validate_json(response.content)


def error_of(response: httpx.Response) -> ErrorResponse:
    return ErrorResponse.model_validate_json(response.content)


def redis_client() -> redis.Redis:
    return redis.Redis.from_url(REDIS_URL)  # pyright: ignore[reportUnknownMemberType]  # untyped options


def subscribe(channel: str) -> PubSub:
    events = redis_client().pubsub()  # pyright: ignore[reportUnknownMemberType]  # untyped options
    events.subscribe(channel)  # pyright: ignore[reportUnknownMemberType]  # untyped handlers
    return events


def stored_job(key: str) -> dict[bytes, bytes]:
    """A job's hash as BullMQ stored it."""
    # The sync client returns the hash itself; redis-py types it as maybe awaitable.
    return _HASH.validate_python(redis_client().hgetall(key))  # pyright: ignore[reportUnknownMemberType]  # see above


_HASH = TypeAdapter(dict[bytes, bytes])


class _Message(BaseModel):
    """A pub/sub message as redis-py hands it over (a dict of unknowns)."""

    type: str
    data: object


_MESSAGE: TypeAdapter[_Message | None] = TypeAdapter(_Message | None)


def published(events: PubSub) -> list[object]:
    """The messages a subscription received so far (waiting a second for each)."""
    messages: list[object] = []
    while (message := _MESSAGE.validate_python(events.get_message(timeout=1))) is not None:
        if message.type == "message" and isinstance(message.data, bytes):
            messages.append(_JSON.validate_json(message.data))
    return messages
