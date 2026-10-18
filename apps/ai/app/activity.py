"""Activity lines: one structured log line per meaningful thing that happens for someone
(a short indexed, a take reviewed, a job run), the same shape and names as the Node
services write (@repo/logger/activity and @repo/contracts/activity, generated into
app/contracts/activity_line.py), so Grafana follows a person across both
(docs/observability.md).

    log_activity("director.take_reviewed", target={"takeId": str(take_id), "score": 82})

The request id, workspace and user bound on the log context (app/auth.py for a request,
app/worker.py for a job) go on the line as they go on every line; the actor is that user
unless one is given. Never message content, a signed URL, or anything a person typed.
"""

from uuid import UUID

import structlog
from pydantic import JsonValue

from app.contracts.activity_line import (
    ActivityActor,
    ActivityLine,
    ActivityName,
    ActivityOutcome,
)
from app.contracts.error_response import ErrorCode
from app.log import log

# What the message of every activity line says, as the Node services' (ACTIVITY_MESSAGE).
ACTIVITY_MESSAGE = "activity"

type Target = dict[str, str | int | float | bool | None]


def _bound_user() -> str | None:
    user = structlog.contextvars.get_contextvars().get("userId")
    return user if isinstance(user, str) else None


def log_activity(
    activity: ActivityName,
    *,
    outcome: ActivityOutcome = "ok",
    reason: str | None = None,
    target: Target | None = None,
    duration_ms: float | None = None,
    user_id: UUID | None = None,
) -> None:
    """Writes one activity line: at warning when it failed (our fault), info otherwise."""
    line = ActivityLine(
        activity=activity,
        actor=ActivityActor(userId=str(user_id) if user_id else _bound_user()),
        outcome=outcome,
        reason=reason,
        durationMs=round(duration_ms) if duration_ms is not None else None,
    )
    fields: dict[str, JsonValue] = line.model_dump(mode="json", exclude_none=True)
    # The target as given: the generated model would turn its whole numbers into floats.
    if target:
        fields["target"] = {**target}
    if outcome == "failed":
        log.warning(ACTIVITY_MESSAGE, **fields)
    else:
        log.info(ACTIVITY_MESSAGE, **fields)


def outcome_of(code: ErrorCode) -> ActivityOutcome:
    """How a plan or a take that ended with `code` reads on an activity line: refused when
    the workspace was out of tokens, failed otherwise. (Not by the code's status: a plan's
    and a take's own failure codes are 4xx in the catalog, since they're never an HTTP
    answer, but they are failures all the same.)"""
    return "refused" if code == "AI_BUDGET_EXCEEDED" else "failed"
