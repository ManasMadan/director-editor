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

import os
import time
from collections.abc import Callable

import httpx
from google.auth import jwt
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from app.errors import AppError
from app.log import log

METADATA_HOST = "metadata.google.internal"
# Short: the metadata server is on the machine's own link, and answers at once or not at all.
METADATA_TIMEOUT_SECONDS = 5.0
# Who signs Google's ID tokens (google-auth checks the signature and the audience; the
# issuer is left to the caller).
GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
# How long Google's keys are kept, and how long fetching them may take: the indexer
# checks every request, and must neither fetch them each time nor hang on them.
CERTS_CACHE_SECONDS = 300.0
CERTS_TIMEOUT_SECONDS = 10.0
# The VM's clock and Cloud Run's can differ by a second or two; a token "issued in the
# future" by that much is still good.
CLOCK_SKEW_SECONDS = 10
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


_CERTS = TypeAdapter(dict[str, str])
# Google's keys, by certificate URL: when each was fetched, and the keys. Google publishes
# a key well before it signs with it, so a few minutes' cache never misses a new one.
_certs_cache: dict[str, tuple[float, dict[str, str]]] = {}


async def google_certs(
    certs_url: str, *, now: Callable[[], float] = time.monotonic
) -> dict[str, str]:
    """Google's ID-token keys (key id to PEM), fetched once per CERTS_CACHE_SECONDS rather
    than for every request checked. httpx's errors, or a ValidationError for an answer
    that isn't Google's format, when they can't be had."""
    cached = _certs_cache.get(certs_url)
    if cached is not None and now() - cached[0] < CERTS_CACHE_SECONDS:
        return cached[1]
    async with httpx.AsyncClient(timeout=CERTS_TIMEOUT_SECONDS) as http:
        response = (await http.get(certs_url)).raise_for_status()
    certs = _CERTS.validate_json(response.content)
    _certs_cache[certs_url] = (now(), certs)
    return certs


async def verify_invoker(token: str, *, audience: str, invoker: str, certs_url: str) -> None:
    """Passes only for an ID token Google signed (its keys at `certs_url`), for
    `audience`, naming `invoker` as a verified email. UNAUTHENTICATED for anything that
    isn't such a token, FORBIDDEN for another account's, UPSTREAM_UNAVAILABLE when
    Google's keys can't be fetched."""
    try:
        certs = await google_certs(certs_url)
    except (httpx.HTTPError, ValidationError) as error:
        log.warning("couldn't fetch google's certificates", error=type(error).__name__)
        raise AppError("UPSTREAM_UNAVAILABLE", {"service": "google"}) from None
    try:
        # google-auth's own check (what its id_token.verify_token does once it has the
        # keys): the signature, the audience, and the token's times, allowing a little
        # drift between the caller's clock and this one's.
        claims = _IdClaims.model_validate(
            jwt.decode(  # pyright: ignore[reportUnknownMemberType]  # google-auth's jwt module is untyped
                token, certs=certs, audience=audience, clock_skew_in_seconds=CLOCK_SKEW_SECONDS
            )
        )
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
