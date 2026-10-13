"""Fixtures for the integration tests (see tests/support.py for the helpers)."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.settings import get_settings
from tests.support import ENV, redis_client


@pytest.fixture
def extra_env() -> dict[str, str]:
    """More environment for the service under test; a test module overrides it."""
    return {}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, extra_env: dict[str, str]) -> Iterator[TestClient]:
    for key, value in {**ENV, **extra_env}.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    redis_client().flushdb()  # pyright: ignore[reportUnknownMemberType]  # untyped options
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()
