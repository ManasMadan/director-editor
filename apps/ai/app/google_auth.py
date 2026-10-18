"""Google credentials from the metadata server, and checking the ID tokens it signs.

On the VM and on Cloud Run, the metadata server hands out tokens for the machine's (or
the service's) own account: no key file anywhere. `id_token` proves to another service
(the Cloud Run indexer) who is calling; `access_token` calls Google's APIs as the
account. `verify_invoker` is the indexer's side: the token is Google's, for this
service, from the one account allowed to call it.

The metadata server's address is google-auth's own GCE_METADATA_HOST (every Google
client library honours it, like the OTEL_* variables in app/telemetry.py), read at each
call, so one setting moves Application Default Credentials and these together; only
tests set it, to a local stand-in.
"""

import asyncio
import os

import httpx
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, Field

from app.errors import AppError
from app.log import log

METADATA_HOST = "metadata.google.internal"
# Short: the metadata server is on the machine's own link, and answers at once or not at all.
METADATA_TIMEOUT_SECONDS = 5.0
# Who signs Google's ID tokens (google-auth checks the signature and the audience; the
# issuer is left to the caller).
GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
_FLAVOR = {"Metadata-Flavor": "Google"}


def _account_url(path: str) -> str:
    host = os.environ.get("GCE_METADATA_HOST", METADATA_HOST)
    return f"http://{host}/computeMetadata/v1/instance/service-accounts/default/{path}"


async def _metadata(path: str, params: dict[str, str] | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=METADATA_TIMEOUT_SECONDS) as http:
        response = await http.get(_account_url(path), params=params, headers=_FLAVOR)
    return response.raise_for_status()


async def id_token(audience: str) -> str:
    """An ID token for `audience` (a Cloud Run service's URL), naming this account's
    email (`format=full`), which the receiving service may check."""
    response = await _metadata("identity", {"audience": audience, "format": "full"})
    return response.text


class _AccessToken(BaseModel):
    access_token: str = Field(min_length=1)


async def access_token() -> str:
    """An OAuth access token for Google's APIs, as this account."""
    return _AccessToken.model_validate_json((await _metadata("token")).content).access_token


class _IdClaims(BaseModel):
    """What the indexer checks of a verified ID token, beyond google-auth's own checks."""

    iss: str
    email: str
    email_verified: bool


async def verify_invoker(token: str, *, audience: str, invoker: str, certs_url: str) -> None:
    """Passes only for an ID token Google signed (its keys at `certs_url`), for
    `audience`, naming `invoker` as a verified email. UNAUTHENTICATED for anything that
    isn't such a token, FORBIDDEN for another account's, UPSTREAM_UNAVAILABLE when
    Google's keys can't be fetched."""
    try:
        claims = await asyncio.to_thread(_verified_claims, token, audience, certs_url)
    except TransportError as error:
        log.warning("couldn't fetch google's certificates", error=str(error))
        raise AppError("UPSTREAM_UNAVAILABLE", {"service": "google"}) from None
    except ValueError as error:
        # Malformed, expired, signed by another key, for another audience, or missing a
        # claim (pydantic's ValidationError is a ValueError too).
        log.warning("refused an id token", error=type(error).__name__)
        raise AppError("UNAUTHENTICATED") from None
    if claims.iss not in GOOGLE_ISSUERS:
        log.warning("refused an id token Google didn't issue", issuer=claims.iss)
        raise AppError("UNAUTHENTICATED")
    if claims.email != invoker or not claims.email_verified:
        log.warning("refused a caller that isn't the invoker", email=claims.email)
        raise AppError("FORBIDDEN")


def _verified_claims(token: str, audience: str, certs_url: str) -> _IdClaims:
    """google-auth's check, blocking (it fetches the certificates with requests)."""
    verified = google_id_token.verify_token(
        token, Request(), audience=audience, certs_url=certs_url
    )
    return _IdClaims.model_validate(verified)
