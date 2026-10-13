"""Every variable the service reads is in .env.example and docs/environment.md, like the
TypeScript services' (scripts/env-docs.test.ts)."""

import re

from app.settings import Settings
from tests import ENV_EXAMPLE

DOCS = ENV_EXAMPLE.parent / "docs" / "environment.md"


def variables() -> list[str]:
    return [field.alias or name.upper() for name, field in Settings.model_fields.items()]


def test_every_variable_is_in_the_example() -> None:
    example = ENV_EXAMPLE.read_text()
    missing = [key for key in variables() if not re.search(rf"^#? ?{key}=", example, re.M)]
    assert missing == []


def test_every_variable_is_documented() -> None:
    docs = DOCS.read_text()
    assert [key for key in variables() if f"`{key}`" not in docs] == []
