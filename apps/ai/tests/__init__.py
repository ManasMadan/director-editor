"""The environment every test runs with, the same locally and in CI, applied when the
tests package is first imported (before tests/support.py reads it): `.env.example`'s
values (the ports docker compose publishes), with placeholder secrets replaced by fresh
ones. Variables already set win, which is how CI points the tests at its own services.
A developer's `.env` is never read. A checkout with its own stack of local services has
`.env.stack` next to it (`bun run setup --stack <n>`), whose ports and URLs win over the
example's. The TypeScript side does the same (packages/testing/src/environment.ts)."""

import os
import re
import secrets
from collections.abc import MutableMapping
from pathlib import Path

from dotenv import dotenv_values

PLACEHOLDER = re.compile(r"^(change-me.*|replace-me.*)$")
ENV_EXAMPLE = Path(__file__).resolve().parents[3] / ".env.example"


def load_test_environment(example: Path = ENV_EXAMPLE) -> dict[str, str]:
    """`.env.example` without NODE_ENV (tests set their own) or empty values (they mean
    "not set", as in CI), placeholders filled."""
    stack = example.parent / ".env.stack"
    loaded = {**dotenv_values(example), **(dotenv_values(stack) if stack.exists() else {})}
    values = {key: value for key, value in loaded.items() if value}
    values.pop("NODE_ENV", None)
    return {
        key: secrets.token_urlsafe(32) if PLACEHOLDER.match(value) else value
        for key, value in values.items()
    }


def apply_test_environment(
    env: MutableMapping[str, str] = os.environ, example: Path = ENV_EXAMPLE
) -> list[str]:
    """Sets every test variable `env` doesn't already have; returns what it set."""
    values = load_test_environment(example)
    applied = [key for key in values if key not in env]
    for key in applied:
        env[key] = values[key]
    return applied


apply_test_environment()
