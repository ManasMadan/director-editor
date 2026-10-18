"""Google's own credentials, against a local metadata server and certificate endpoint
that speak the real protocol (tests/fakes.py's `serve_identity`): ID and access tokens
from the metadata server, and the indexer's check of the ID token it is called with."""

import time
from collections.abc import Iterator

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import TypeAdapter

from app.errors import AppError
from app.google_auth import (
    CERTS_CACHE_SECONDS,
    access_token,
    google_certs,
    id_token,
    verify_invoker,
)
from tests.fakes import (
    ACCESS_TOKEN,
    CERTS_PATH,
    SERVICE_ACCOUNT,
    Identity,
    serve_files,
    serve_identity,
)

pytestmark = pytest.mark.integration

AUDIENCE = "https://director-indexer.test"
_CLAIMS = TypeAdapter(dict[str, object])


@pytest.fixture
def identity(monkeypatch: pytest.MonkeyPatch) -> Iterator[Identity]:
    with serve_identity() as found:
        monkeypatch.setenv("GCE_METADATA_HOST", found.host)
        yield found


async def test_an_id_token_is_the_metadata_server_s_for_the_audience(identity: Identity) -> None:
    token = await id_token(AUDIENCE)
    claims = _CLAIMS.validate_python(jwt.decode(token, options={"verify_signature": False}))
    assert (claims["aud"], claims["email"]) == (AUDIENCE, SERVICE_ACCOUNT)
    # format=full: the token names the service account, which the indexer checks.
    assert identity.requests == [
        "/computeMetadata/v1/instance/service-accounts/default/identity"
        "?audience=https%3A%2F%2Fdirector-indexer.test&format=full"
    ]


async def test_an_access_token_is_the_metadata_server_s(identity: Identity) -> None:
    assert await access_token() == ACCESS_TOKEN
    assert identity.requests == ["/computeMetadata/v1/instance/service-accounts/default/token"]


async def test_a_metadata_server_that_refuses_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # Something at that address that isn't a metadata server: every path is a 404.
    with serve_files({}) as elsewhere:
        monkeypatch.setenv("GCE_METADATA_HOST", elsewhere.url.removeprefix("http://"))
        with pytest.raises(Exception, match="404"):
            await id_token(AUDIENCE)
        with pytest.raises(Exception, match="404"):
            await access_token()


async def _verify(identity: Identity, token: str) -> None:
    await verify_invoker(
        token,
        audience=AUDIENCE,
        invoker=SERVICE_ACCOUNT,
        certs_url=f"{identity.url}{CERTS_PATH}",
    )


async def test_the_expected_account_calling_this_service_passes(identity: Identity) -> None:
    await _verify(identity, identity.token(AUDIENCE))


@pytest.mark.parametrize(
    ("claims", "code"),
    [
        ({"aud": "https://someone-else.test"}, "UNAUTHENTICATED"),
        ({"exp": 1_000, "iat": 900}, "UNAUTHENTICATED"),
        ({"iss": "https://evil.test"}, "UNAUTHENTICATED"),
        ({"email": None}, "UNAUTHENTICATED"),
        ({"email": "someone@test-project.iam.gserviceaccount.com"}, "FORBIDDEN"),
        ({"email_verified": False}, "FORBIDDEN"),
    ],
    ids=[
        "another audience",
        "expired",
        "not Google's",
        "no email",
        "another account",
        "unverified",
    ],
)
async def test_any_other_token_is_refused(
    identity: Identity, claims: dict[str, object], code: str
) -> None:
    with pytest.raises(AppError) as refused:
        await _verify(identity, identity.token(AUDIENCE, **claims))
    assert refused.value.code == code


async def test_a_token_google_didn_t_sign_is_refused(identity: Identity) -> None:
    claims = _CLAIMS.validate_python(
        jwt.decode(identity.token(AUDIENCE), options={"verify_signature": False})
    )
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    signed_elsewhere = jwt.encode(claims, other, "RS256", {"kid": identity.key_id})
    unknown_key = jwt.encode(claims, identity.key, "RS256", {"kid": "not-google-s"})
    for token in (signed_elsewhere, unknown_key, "not.a.jwt"):
        with pytest.raises(AppError) as refused:
            await _verify(identity, token)
        assert refused.value.code == "UNAUTHENTICATED"


async def test_certificates_that_can_t_be_fetched_are_an_upstream_failure(
    identity: Identity,
) -> None:
    with pytest.raises(AppError) as unavailable:
        await verify_invoker(
            identity.token(AUDIENCE),
            audience=AUDIENCE,
            invoker=SERVICE_ACCOUNT,
            certs_url=f"{identity.url}/no-certs-here",
        )
    assert unavailable.value.code == "UPSTREAM_UNAVAILABLE"


async def test_google_s_certificates_are_fetched_once_while_fresh(identity: Identity) -> None:
    """Fetched on the first token and kept for CERTS_CACHE_SECONDS, not fetched again for
    every request the indexer checks."""
    for _ in range(3):
        await _verify(identity, identity.token(AUDIENCE))
    assert identity.requests.count(CERTS_PATH) == 1
    url = f"{identity.url}{CERTS_PATH}"
    _ = await google_certs(url, now=lambda: time.monotonic() + CERTS_CACHE_SECONDS - 1)
    assert identity.requests.count(CERTS_PATH) == 1
    _ = await google_certs(url, now=lambda: time.monotonic() + CERTS_CACHE_SECONDS + 1)
    assert identity.requests.count(CERTS_PATH) == 2


async def test_a_token_from_a_clock_a_little_ahead_passes(identity: Identity) -> None:
    """A few seconds between the VM's clock and Cloud Run's must not refuse every call."""
    now = int(time.time())
    await _verify(identity, identity.token(AUDIENCE, iat=now + 5, exp=now + 3605))


async def test_certificates_that_aren_t_google_s_format_are_an_upstream_failure(
    identity: Identity,
) -> None:
    # The metadata server's "/" answers plain text, not a JSON map of keys.
    with pytest.raises(AppError) as unavailable:
        await verify_invoker(
            identity.token(AUDIENCE),
            audience=AUDIENCE,
            invoker=SERVICE_ACCOUNT,
            certs_url=f"{identity.url}/",
        )
    assert unavailable.value.code == "UPSTREAM_UNAVAILABLE"
