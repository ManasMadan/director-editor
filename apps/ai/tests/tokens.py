"""Tokens as apps/api signs them, for tests."""

import secrets
import time
from uuid import UUID

import jwt

# Fresh for every run, like the secrets the test environment fills in.
SECRET = secrets.token_urlsafe(32)


def service_token(
    user_id: UUID, org_id: UUID, *, secret: str = SECRET, lifetime: int = 60, **overrides: object
) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "iss": "api",
        "aud": "ai",
        "sub": str(user_id),
        "org": str(org_id),
        "iat": now,
        "exp": now + lifetime,
        **overrides,
    }
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, secret, algorithm="HS256")
