"""Structured logs: one JSON object per line in production, readable output locally.

Every line carries the request id, workspace and user of the request or job that produced
it (`requestId`, `orgId`, `userId`, bound by app/auth.py and app/worker.py), the same
fields the TypeScript services log, so one request can be followed across services; with
telemetry on, also the trace (`traceId`).

Secrets never reach the output: `redact` censors every field named like a credential, at
any depth, and a presigned URL's query (its signature), as @repo/logger does for the Node
services.
"""

import logging
import re
from collections.abc import Mapping
from typing import TypeIs, cast

import structlog
from structlog.typing import EventDict, FilteringBoundLogger

from app.telemetry import add_trace_ids

# Field names censored wherever they appear, compared in lower case: the same list as
# @repo/logger's SENSITIVE_KEYS.
SENSITIVE_KEYS = frozenset(
    {
        "password",
        "newpassword",
        "currentpassword",
        "otp",
        "token",
        "secret",
        "accesstoken",
        "access_token",
        "refreshtoken",
        "refresh_token",
        "idtoken",
        "id_token",
        "sessiontoken",
        "session_token",
        "clientsecret",
        "client_secret",
        "apikey",
        "authorization",
        "cookie",
        "set-cookie",
        "backupcodes",
    }
)
CENSOR = "[redacted]"
_MAX_DEPTH = 8
# Whoever has a presigned URL's signature can read the object: S3's, GCS's, older schemes'.
_SIGNED_URL = re.compile(r"\?(.*&)?(x-amz-signature|x-goog-signature|signature)=", re.I | re.S)


def _is_mapping(value: object) -> TypeIs[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _is_sequence(value: object) -> TypeIs[list[object] | tuple[object, ...]]:
    return isinstance(value, list | tuple)


def _scrub_fields(fields: Mapping[object, object], depth: int) -> dict[object, object]:
    return {
        key: CENSOR
        if isinstance(key, str) and key.lower() in SENSITIVE_KEYS
        else _scrub(inner, depth + 1)
        for key, inner in fields.items()
    }


def _scrub(value: object, depth: int = 0) -> object:
    if isinstance(value, str):
        return f"{value.split('?', 1)[0]}?{CENSOR}" if _SIGNED_URL.search(value) else value
    if depth >= _MAX_DEPTH:
        return value
    if _is_mapping(value):
        return _scrub_fields(value, depth)
    if _is_sequence(value):
        return [_scrub(item, depth + 1) for item in value]
    return value


def redact(_logger: object, _method: str, event: EventDict) -> EventDict:
    """structlog processor: every sensitive field censored, every signed URL cut short."""
    return _redacted(event)


def _redacted(fields: Mapping[str, object]) -> dict[str, object]:
    return {
        key: CENSOR if key.lower() in SENSITIVE_KEYS else _scrub(inner, 1)
        for key, inner in fields.items()
    }


def configure_logging(level: str, json: bool) -> None:
    logging.basicConfig(format="%(message)s", level=level.upper())
    processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        add_trace_ids,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        redact,
    ]
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[*processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
        cache_logger_on_first_use=True,
    )


# structlog.get_logger() is untyped; configure_logging makes it a filtering bound logger.
log = cast(FilteringBoundLogger, structlog.get_logger())
