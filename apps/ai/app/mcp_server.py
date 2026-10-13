"""The AI service's MCP server: the approved workspace's documents, for MCP clients.

Unlike the rest of this service it's reached from outside (the gateway routes /ai/mcp
and its metadata here), so it authenticates every request itself: an OAuth access token
from apps/api's authorization server, for this resource (RFC 8707 audience), signed
with a key from the api's JWKS, naming a workspace, and whose grant still stands
(auth.mcp_grant_active: the user still approves the app for that workspace and is still
a member). Tools then run in that workspace, under row-level security like any request.

Only allowlisted tools exist. To add one: give it a scope in
packages/contracts/src/mcp.ts (and the api's resource policy in auth.ts), register it in
`create_mcp_server` behind that scope, and cover it in tests/test_mcp.py.
"""

import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Protocol
from uuid import UUID, uuid4

import httpx
import jwt
import structlog
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl, BaseModel, Field, TypeAdapter
from redis.asyncio import Redis
from sqlalchemy import text
from starlette.applications import Starlette

from app.db.session import engine
from app.documents import Documents
from app.log import log

MCP_PATH = "/ai/mcp"
# What the server answers: the endpoint, and its OAuth protected-resource metadata.
MCP_PATHS = frozenset({MCP_PATH, f"/.well-known/oauth-protected-resource{MCP_PATH}"})
SCOPE = "documents:read"
ORG_CLAIM = "org"
# Tool calls per app and user per minute (the api's MCP server allows the same).
CALLS_PER_MINUTE = 60
# A token with a key id we haven't seen refetches the keys at most this often, so a
# stream of forged key ids can't turn into a stream of requests to the api.
KEY_REFRESH_SECONDS = 30

type Jwks = dict[str, object]
_JWKS = TypeAdapter[Jwks](Jwks)


class ApiKeys:
    """The api's signing keys (its JWKS), fetched on first use and after a rotation."""

    def __init__(
        self,
        jwks_url: str,
        fetch: Callable[[str], Awaitable[Jwks]],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = jwks_url
        self._fetch = fetch
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None

    async def get(self, kid: str) -> jwt.PyJWK | None:
        due = self._fetched_at is None or self._clock() - self._fetched_at >= KEY_REFRESH_SECONDS
        if kid not in self._keys and due:
            jwks = jwt.PyJWKSet.from_dict(await self._fetch(self._url))
            self._keys = {key.key_id: key for key in jwks.keys if key.key_id}
            self._fetched_at = self._clock()
        return self._keys.get(kid)


async def _fetch_json(url: str) -> Jwks:
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(url)
        response.raise_for_status()
        return _JWKS.validate_json(response.content)


async def grant_active(client_id: str, user_id: UUID, org_id: UUID) -> bool:
    async with engine().connect() as connection:
        result = await connection.execute(
            text("SELECT auth.mcp_grant_active(:client_id, :user_id, :org_id)"),
            {"client_id": client_id, "user_id": user_id, "org_id": org_id},
        )
        return bool(result.scalar())


class _Header(BaseModel):
    kid: str | None = None


class _Claims(BaseModel):
    """What this server needs from a token, beyond what PyJWT checks itself."""

    sub: UUID
    org: UUID
    # The OAuth client the token was issued to.
    azp: str
    exp: int
    scope: str | None = None


class ApiTokenVerifier:
    """Checks an access token the way the api's own MCP server does (apps/api/src/mcp)."""

    def __init__(
        self,
        keys: ApiKeys,
        issuer: str,
        resource: str,
        grant: Callable[[str, UUID, UUID], Awaitable[bool]] = grant_active,
    ) -> None:
        self._keys = keys
        self._issuer = issuer
        self._resource = resource
        self._grant = grant

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            kid = _Header.model_validate(jwt.get_unverified_header(token)).kid
            key = await self._keys.get(kid) if kid else None
            if key is None:
                return None
            claims = _Claims.model_validate(
                jwt.decode(
                    token,
                    key=key,
                    algorithms=[key.algorithm_name],
                    audience=self._resource,
                    issuer=self._issuer,
                    options={"require": ["exp", "sub", "aud", "iss"]},
                )
            )
        # A pydantic ValidationError is a ValueError: a claim that's missing or malformed.
        except jwt.PyJWTError, ValueError:
            return None
        if not await self._grant(claims.azp, claims.sub, claims.org):
            return None
        return AccessToken(
            token=token,
            client_id=claims.azp,
            scopes=claims.scope.split() if claims.scope else [],
            expires_at=claims.exp,
            resource=self._resource,
            subject=str(claims.sub),
            claims={ORG_CLAIM: str(claims.org)},
        )


class DocumentSummary(BaseModel):
    id: UUID
    title: str
    status: str
    summary: str | None


class PassageResult(BaseModel):
    document_id: UUID
    title: str
    content: str
    score: float


class Caller(BaseModel):
    user_id: UUID
    org_id: UUID
    client_id: str


def current_caller() -> Caller:
    """Who is calling: set by the auth middleware for every request that reaches a tool."""
    token = get_access_token()
    if token is None or token.subject is None or token.claims is None:
        raise PermissionError("no authenticated MCP caller")
    # The claims are the ones verify_token set: {ORG_CLAIM: <the workspace id>}.
    org_id: object = token.claims.get(ORG_CLAIM)
    if not isinstance(org_id, str):
        raise PermissionError("the MCP caller's token names no workspace")
    return Caller(user_id=UUID(token.subject), org_id=UUID(org_id), client_id=token.client_id)


class Counters(Protocol):
    """What the rate limit needs of Redis. redis-py types the async client's replies as
    Any; this says only that each is awaited, and within_limit checks what it gets."""

    def incr(self, name: str) -> Awaitable[object]: ...

    def expire(self, name: str, time: int) -> Awaitable[object]: ...


async def within_limit(redis: Counters, caller: Caller) -> bool:
    """A fixed one-minute window per app and user. A reply that isn't a count refuses."""
    key = f"{{rl:ai-mcp}}:{caller.client_id}:{caller.user_id}:{int(time.time() // 60)}"
    calls = await redis.incr(key)
    if calls == 1:
        await redis.expire(key, 60)
    return isinstance(calls, int) and calls <= CALLS_PER_MINUTE


def create_mcp_server(
    *,
    site_url: str,
    api_url: str,
    release: str,
    documents: Callable[[], Documents],
    redis: Callable[[], Redis],
    verifier: ApiTokenVerifier | None = None,
) -> MCPServer:
    site = site_url.rstrip("/")
    resource = f"{site}{MCP_PATH}"
    issuer = f"{site}/api/auth"
    keys = ApiKeys(f"{api_url.rstrip('/')}/api/auth/jwks", _fetch_json)
    server = MCPServer(
        name="boilerplate-documents",
        version=release,
        token_verifier=verifier or ApiTokenVerifier(keys, issuer, resource),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(issuer),
            resource_server_url=AnyHttpUrl(resource),
            required_scopes=[SCOPE],
            validate_token_resource=True,
        ),
    )

    @asynccontextmanager
    async def tool_call(ctx: Context) -> AsyncGenerator[Caller]:
        """Who is calling, within their rate limit, with the request id on every log
        line. A failure inside the tool is logged and answered as INTERNAL with the
        request id: the client never sees what went wrong inside."""
        caller = current_caller()
        request_id = (ctx.headers or {}).get("x-request-id") or f"mcp:{uuid4()}"
        with structlog.contextvars.bound_contextvars(
            request_id=request_id, org_id=str(caller.org_id), user_id=str(caller.user_id)
        ):
            if not await within_limit(redis(), caller):
                # ToolError's message is what the client sees.
                raise ToolError("RATE_LIMITED: too many calls; wait a minute and try again")
            try:
                yield caller
            except Exception as error:
                log.exception("mcp tool failed")
                raise ToolError(f"INTERNAL: the tool failed (request id {request_id})") from error

    @server.tool(
        name="list_documents",
        title="List documents",
        description="The workspace's documents, newest first, with their status and summary.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    async def list_documents(ctx: Context) -> list[DocumentSummary]:
        async with tool_call(ctx) as caller:
            rows = await documents().list(caller.org_id)
            return [
                DocumentSummary(id=row.id, title=row.title, status=row.status, summary=row.summary)
                for row in rows
            ]

    @server.tool(
        name="search_documents",
        title="Search documents",
        description=(
            "Finds the passages of the workspace's documents that best match `query` "
            "(meaning, not just words), best first."
        ),
        annotations=ToolAnnotations(read_only_hint=True),
    )
    async def search_documents(
        ctx: Context,
        query: str = Field(min_length=1, max_length=2_000),
        limit: int = Field(default=5, ge=1, le=20),
    ) -> list[PassageResult]:
        async with tool_call(ctx) as caller:
            passages = await documents().search(caller.org_id, query, limit)
            return [
                PassageResult(
                    document_id=passage.document_id,
                    title=passage.title,
                    content=passage.content,
                    score=passage.score,
                )
                for passage in passages
            ]

    return server


def mcp_app(server: MCPServer) -> Starlette:
    return server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        # Every request stands alone: any replica can answer, nothing is kept between calls.
        stateless_http=True,
        json_response=True,
        # DNS-rebinding protection guards unauthenticated local servers; here every request
        # carries a bearer token (no cookies), and the Host is the public site's.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
