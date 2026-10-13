"""Structured logs: one JSON object per line in production, readable output locally.

Every line carries the request id, organization and user of the request or job that
produced it (bound by app/context.py), the same fields the TypeScript services log,
so one request can be followed across services; with telemetry on, also the trace.
"""

import logging
from typing import cast

import structlog
from structlog.typing import FilteringBoundLogger

from app.telemetry import add_trace_ids


def configure_logging(level: str, json: bool) -> None:
    logging.basicConfig(format="%(message)s", level=level.upper())
    processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        add_trace_ids,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
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
