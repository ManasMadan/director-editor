"""The MCP server (app/mcp_server.py): token checks on their own, then the mounted server
over HTTP with tokens signed like apps/api signs them and grants in the real database.
The api's side (issuing those tokens) is covered in apps/api/test/oauth.integration.test.ts.
"""

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import UUID, uuid4

import httpx2 as httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from jwt.algorithms import OKPAlgorithm
from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from pydantic import BaseModel

from app.documents import Documents
from app.mcp_server import (
    ApiKeys,
    ApiTokenVerifier,
    Caller,
    DocumentSummary,
    Jwks,
    PassageResult,
    current_caller,
    within_limit,
)
from tests.support import error_of, headers, index_all, migrator, new_org

SITE = "https://site.test"
ISSUER = f"{SITE}/api/auth"
RESOURCE = f"{SITE}/ai/mcp"


class SigningKey:
    def __init__(self, kid: str) -> None:
        self.kid = kid
        self.private = Ed25519PrivateKey.generate()
        jwk = OKPAlgorithm.to_jwk(self.private.public_key(), as_dict=True)
        self.jwk: dict[str, object] = {**jwk, "kid": kid, "alg": "EdDSA", "use": "sig"}

    def sign(self, **claims: object) -> str:
        now = int(time.time())
        payload: dict[str, object] = {
            "iss": ISSUER,
            "aud": RESOURCE,
            "sub": str(uuid4()),
            "org": str(uuid4()),
            "azp": "client-1",
            "scope": "documents:read",
            "iat": now,
            "exp": now + 900,
            **claims,
        }
        return jwt.encode(
            {k: v for k, v in payload.items() if v is not None},
            self.private,
            algorithm="EdDSA",
            headers={"kid": self.kid},
        )


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def verifier(
    keys: list[SigningKey], grant: bool = True, clock: Clock | None = None
) -> tuple[ApiTokenVerifier, list[int], list[tuple[str, UUID, UUID]]]:
    fetches: list[int] = []
    grants: list[tuple[str, UUID, UUID]] = []

    async def fetch(_url: str) -> Jwks:
        fetches.append(1)
        return {"keys": [key.jwk for key in keys]}

    async def grant_active(client_id: str, user_id: UUID, org_id: UUID) -> bool:
        grants.append((client_id, user_id, org_id))
        return grant

    return (
        ApiTokenVerifier(
            ApiKeys("unused", fetch, clock or Clock()), ISSUER, RESOURCE, grant_active
        ),
        fetches,
        grants,
    )


# ------------------------------------------------------------------------ token checks


async def test_a_valid_token_names_the_caller_and_workspace() -> None:
    key = SigningKey("k1")
    check, _, grants = verifier([key])
    user, org = uuid4(), uuid4()
    token = await check.verify_token(key.sign(sub=str(user), org=str(org)))
    assert token is not None
    assert (token.subject, token.claims, token.client_id) == (
        str(user),
        {"org": str(org)},
        "client-1",
    )
    assert token.scopes == ["documents:read"]
    assert token.resource == RESOURCE
    assert grants == [("client-1", user, org)]


async def test_a_token_without_scopes_has_none() -> None:
    key = SigningKey("k1")
    check, _, _ = verifier([key])
    token = await check.verify_token(key.sign(scope=None))
    assert token is not None
    assert token.scopes == []


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": int(time.time()) - 60},
        {"iss": "https://elsewhere.test/api/auth"},
        {"aud": f"{SITE}/api/mcp"},
        {"org": None},
        {"org": "not-a-uuid"},
        {"azp": None},
        {"sub": None},
    ],
    ids=[
        "expired",
        "other issuer",
        "other resource",
        "no workspace",
        "bad workspace",
        "no client",
        "no user",
    ],
)
async def test_bad_tokens_are_refused(claims: dict[str, object]) -> None:
    key = SigningKey("k1")
    check, _, _ = verifier([key])
    assert await check.verify_token(key.sign(**claims)) is None


async def test_a_token_signed_with_another_key_is_refused() -> None:
    ours, theirs = SigningKey("k1"), SigningKey("k1")
    check, _, _ = verifier([ours])
    assert await check.verify_token(theirs.sign()) is None
    assert await check.verify_token("not.a.token") is None


async def test_a_token_without_a_key_id_is_refused() -> None:
    key = SigningKey("k1")
    check, fetches, _ = verifier([key])
    unnamed = jwt.encode({"sub": str(uuid4())}, key.private, algorithm="EdDSA")
    assert await check.verify_token(unnamed) is None
    assert fetches == []


async def test_a_grant_that_no_longer_stands_is_refused() -> None:
    key = SigningKey("k1")
    check, _, _ = verifier([key], grant=False)
    assert await check.verify_token(key.sign()) is None


async def test_keys_are_fetched_once_and_again_only_for_an_unknown_key_id() -> None:
    first = SigningKey("k1")
    keys = [first]
    clock = Clock()
    check, fetches, _ = verifier(keys, clock=clock)
    assert await check.verify_token(first.sign()) is not None
    assert await check.verify_token(first.sign()) is not None
    assert len(fetches) == 1
    # A new key right after the last fetch waits for the refresh interval: forged key
    # ids can't make this service hammer the api.
    second = SigningKey("k2")
    keys.append(second)
    assert await check.verify_token(second.sign()) is None
    assert len(fetches) == 1
    clock.now += 60
    assert await check.verify_token(second.sign()) is not None
    assert len(fetches) == 2


def test_tools_run_only_for_an_authenticated_caller() -> None:
    # The auth middleware sets the caller for every request that reaches a tool; outside
    # one there is none, and a tool must not run.
    with pytest.raises(PermissionError):
        current_caller()


def test_a_token_without_a_workspace_is_refused() -> None:
    # verify_token always sets the claim; a caller without one must not reach a tool anyway.
    token = AccessToken(
        token=SigningKey("k").sign(), client_id="app", scopes=[], subject=str(uuid4()), claims={}
    )
    reset = auth_context_var.set(AuthenticatedUser(token))
    try:
        with pytest.raises(PermissionError):
            current_caller()
    finally:
        auth_context_var.reset(reset)


class Garbled:
    """Redis answering INCR with something that isn't a count."""

    async def incr(self, name: str) -> object:
        return b"garbled"

    async def expire(self, name: str, time: int) -> object:
        return True


async def test_a_reply_that_is_not_a_count_refuses_the_call() -> None:
    caller = Caller(user_id=uuid4(), org_id=uuid4(), client_id="app")
    assert not await within_limit(Garbled(), caller)


# ------------------------------------------------------------------ the mounted server

KEY = SigningKey("integration")


class _Jwks(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = json.dumps({"keys": [KEY.jwk]}).encode()
        self.send_response(200 if self.path == "/api/auth/jwks" else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def api_url() -> Iterator[str]:
    """Stands in for apps/api's JWKS endpoint."""
    server = HTTPServer(("127.0.0.1", 0), _Jwks)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def extra_env(api_url: str) -> dict[str, str]:
    """Turns the MCP server on (see app/settings.py), with the stub as the api."""
    return {"BETTER_AUTH_URL": SITE, "API_URL": api_url}


def granted(org: UUID, user: UUID, client_id: str = "client-1") -> None:
    """What approving an app on the consent page leaves in the database."""
    with migrator() as db:
        db.execute(
            "INSERT INTO auth.member (organization_id, user_id, role) VALUES (%s, %s, 'member')",
            (org, user),
        )
        db.execute(
            "INSERT INTO auth.oauth_client (client_id) VALUES (%s) ON CONFLICT DO NOTHING",
            (client_id,),
        )
        db.execute(
            "INSERT INTO auth.oauth_consent (client_id, user_id, reference_id, scopes, updated_at)"
            " VALUES (%s, %s, %s, ARRAY['documents:read'], now())",
            (client_id, user, org),
        )


# What the server answers, as far as these tests read it.
class _Envelope(BaseModel):
    result: dict[str, object]


class _Text(BaseModel):
    text: str


class ToolResult(BaseModel):
    content: list[_Text]
    isError: bool = False


class _Documents(BaseModel):
    result: list[DocumentSummary]


class Listed(ToolResult):
    structuredContent: _Documents


class _Passages(BaseModel):
    result: list[PassageResult]


class Found(ToolResult):
    structuredContent: _Passages


class _Tool(BaseModel):
    name: str


class Tools(BaseModel):
    tools: list[_Tool]


class Metadata(BaseModel):
    resource: str
    authorization_servers: list[str]
    scopes_supported: list[str]


def rpc(
    client: TestClient,
    token: str | None,
    method: str,
    params: dict[str, object],
    request_id: str | None = None,
) -> httpx.Response:
    return client.post(
        "/ai/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        headers={
            "accept": "application/json, text/event-stream",
            **({"authorization": f"Bearer {token}"} if token else {}),
            **({"x-request-id": request_id} if request_id else {}),
        },
    )


def result_of[R: BaseModel](response: httpx.Response, shape: type[R]) -> R:
    assert response.status_code == 200, response.text
    return shape.model_validate(_Envelope.model_validate_json(response.content).result)


def call[R: BaseModel](
    client: TestClient,
    token: str,
    tool: str,
    arguments: dict[str, object],
    shape: type[R],
    request_id: str | None = None,
) -> R:
    response = rpc(client, token, "tools/call", {"name": tool, "arguments": arguments}, request_id)
    return result_of(response, shape)


def token_for(org: UUID, user: UUID, **claims: object) -> str:
    return KEY.sign(sub=str(user), org=str(org), **claims)


@pytest.mark.integration
def test_without_a_token_the_challenge_points_at_the_metadata(client: TestClient) -> None:
    response = rpc(client, None, "tools/list", {})
    assert response.status_code == 401
    assert (
        f'resource_metadata="{SITE}/.well-known/oauth-protected-resource/ai/mcp"'
        in response.headers["www-authenticate"]
    )
    metadata = Metadata.model_validate_json(
        client.get("/.well-known/oauth-protected-resource/ai/mcp").content
    )
    assert metadata.resource == RESOURCE
    assert metadata.authorization_servers == [ISSUER]
    assert metadata.scopes_supported == ["documents:read"]


@pytest.mark.integration
def test_other_routes_stay_the_service_s_own(client: TestClient) -> None:
    response = client.get("/ai/nope")
    assert response.status_code == 404
    assert error_of(response).code == "NOT_FOUND"


@pytest.mark.integration
def test_the_workspace_s_documents_can_be_listed_and_searched(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    client.post(
        "/v1/documents",
        json={"title": "Refunds", "content": "Refunds take five business days."},
        headers=headers(org, user),
    )
    index_all(client, org)
    token = token_for(org, user)

    tools = result_of(rpc(client, token, "tools/list", {}), Tools).tools
    assert sorted(tool.name for tool in tools) == ["list_documents", "search_documents"]

    [listed] = call(client, token, "list_documents", {}, Listed).structuredContent.result
    assert (listed.title, listed.status) == ("Refunds", "ready")
    found = call(client, token, "search_documents", {"query": "how long do refunds take"}, Found)
    [best, *_] = found.structuredContent.result
    assert best.title == "Refunds"
    assert "five business days" in best.content


@pytest.mark.integration
def test_only_the_approved_workspace_is_visible(client: TestClient) -> None:
    theirs, owner = new_org()
    client.post(
        "/v1/documents",
        json={"title": "Private", "content": "Only for the other workspace."},
        headers=headers(theirs, owner),
    )
    index_all(client, theirs)
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    assert call(client, token, "list_documents", {}, Listed).structuredContent.result == []
    found = call(client, token, "search_documents", {"query": "other workspace"}, Found)
    assert found.structuredContent.result == []


@pytest.mark.integration
def test_a_token_without_the_documents_scope_is_refused(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    response = rpc(client, token_for(org, user, scope="todos:read"), "tools/list", {})
    assert response.status_code == 403
    assert 'error="insufficient_scope"' in response.headers["www-authenticate"]


@pytest.mark.integration
def test_access_ends_when_the_app_is_disconnected_or_the_user_leaves(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    assert rpc(client, token, "tools/list", {}).status_code == 200
    with migrator() as db:
        db.execute("DELETE FROM auth.oauth_consent WHERE user_id = %s", (user,))
    assert rpc(client, token, "tools/list", {}).status_code == 401

    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    with migrator() as db:
        db.execute("DELETE FROM auth.member WHERE user_id = %s", (user,))
    assert rpc(client, token, "tools/list", {}).status_code == 401


@pytest.mark.integration
def test_a_token_for_the_other_mcp_server_is_refused(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    response = rpc(client, token_for(org, user, aud=f"{SITE}/api/mcp"), "tools/list", {})
    assert response.status_code == 401


@pytest.mark.integration
def test_tool_input_is_validated(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    result = call(client, token_for(org, user), "search_documents", {"query": ""}, ToolResult)
    assert result.isError is True


@pytest.mark.integration
def test_calls_are_limited_per_app_and_user(client: TestClient) -> None:
    org, user = new_org()
    granted(org, user)
    token = token_for(org, user)
    results = [call(client, token, "list_documents", {}, ToolResult) for _ in range(61)]
    assert not any(result.isError for result in results[:60])
    assert results[60].isError is True
    assert "RATE_LIMITED" in results[60].content[0].text


@pytest.mark.integration
def test_a_failing_tool_is_logged_and_tells_the_client_only_the_request_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    org, user = new_org()
    granted(org, user)

    async def broken(_self: Documents, _org_id: UUID) -> list[object]:
        raise RuntimeError("connection to 10.0.0.7 refused")

    monkeypatch.setattr(Documents, "list", broken)

    def shown(request_id: str | None) -> str:
        result = call(client, token_for(org, user), "list_documents", {}, ToolResult, request_id)
        assert result.isError is True
        [content] = result.content
        return content.text

    # The SDK puts "Error executing tool list_documents: " in front.
    with_id = shown("req-mcp")
    assert with_id.endswith(": INTERNAL: the tool failed (request id req-mcp)")
    assert "10.0.0.7" not in with_id
    assert "(request id mcp:" in shown(None)
    logged = capfd.readouterr().out
    assert "mcp tool failed" in logged
    assert "req-mcp" in logged
    assert "connection to 10.0.0.7 refused" in logged
