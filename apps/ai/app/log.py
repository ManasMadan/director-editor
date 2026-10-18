"""Structured logs: one JSON object per line in production, readable output locally.

Every line carries the request id, workspace and user of the request or job that produced
it (`requestId`, `orgId`, `userId`, bound by app/auth.py and app/worker.py), the same
fields the TypeScript services log, so one request can be followed across services; with
telemetry on, also the trace (`traceId`).

Secrets never reach the output: `redact` censors every field named like a credential,
at any depth and in any casing style, and the value of every secret query parameter (a
presigned URL's signature) in any text, the message and exception text included, as
@repo/logger does for the Node services.
"""

import logging
import re
from collections.abc import Mapping
from typing import TypeIs, cast

import structlog
from structlog.typing import EventDict, FilteringBoundLogger

from app.telemetry import add_trace_ids

CENSOR = "[redacted]"
_MAX_DEPTH = 8

# The same rules as @repo/logger's (packages/logger/src/index.ts): a name is compared in
# lower case with `-` and `_` taken out, so apiKey, api_key and X-Api-Key are one name.
# A field is a credential when its name ends in "token" (not "tokens": the counts of
# tokens a model used are kept) or holds one of these.
_SECRET_FIELD_PARTS = (
    "password",
    "secret",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "backupcode",
)
# And a URL's query parameter is a credential when its name holds one of these, or is one
# of the short names that are (a presigned URL's signature and key, an OAuth code).
_SECRET_PARAM_PARTS = ("signature", "credential", "token", "secret", "password", "apikey")
_SECRET_PARAMS = frozenset({"sig", "key", "code", "otp"})
# A query parameter anywhere in a string (a URL, an error's message, a stack trace).
_QUERY_PARAM = re.compile(r"([?&])([^=&#\s\"'<>]+)=([^&#\s\"'<>]*)")


def _normalized(name: str) -> str:
    return name.lower().replace("-", "").replace("_", "")


def is_secret_field(name: str) -> bool:
    """Whether a field of this name holds a credential, whatever its casing style."""
    normalized = _normalized(name)
    return (
        normalized == "otp"
        or normalized.endswith("token")
        or any(part in normalized for part in _SECRET_FIELD_PARTS)
    )


def _is_secret_param(name: str) -> bool:
    normalized = _normalized(name)
    return normalized in _SECRET_PARAMS or any(part in normalized for part in _SECRET_PARAM_PARTS)


def _censor_param(match: re.Match[str]) -> str:
    separator, name = match.group(1), match.group(2)
    return f"{separator}{name}={CENSOR}" if _is_secret_param(name) else match.group(0)


def scrub_text(value: str) -> str:
    """The text with each secret query parameter's value censored and the rest kept: a
    presigned URL keeps its path, and a stack trace naming one keeps its other lines."""
    return _QUERY_PARAM.sub(_censor_param, value)


def _is_mapping(value: object) -> TypeIs[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _is_sequence(value: object) -> TypeIs[list[object] | tuple[object, ...]]:
    return isinstance(value, list | tuple)


def _scrub_fields(fields: Mapping[object, object], depth: int) -> dict[object, object]:
    return {
        key: CENSOR if isinstance(key, str) and is_secret_field(key) else _scrub(inner, depth + 1)
        for key, inner in fields.items()
    }


def _scrub(value: object, depth: int = 0) -> object:
    if isinstance(value, str):
        return scrub_text(value)
    if depth >= _MAX_DEPTH:
        return value
    if _is_mapping(value):
        return _scrub_fields(value, depth)
    if _is_sequence(value):
        return [_scrub(item, depth + 1) for item in value]
    return value


def redact(_logger: object, _method: str, event: EventDict) -> EventDict:
    """structlog processor: every credential field censored, and every secret query
    parameter, in the message and the exception text too (both are fields by now)."""
    return _redacted(event)


def _redacted(fields: Mapping[str, object]) -> dict[str, object]:
    return {
        key: CENSOR if is_secret_field(key) else _scrub(inner, 1) for key, inner in fields.items()
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
