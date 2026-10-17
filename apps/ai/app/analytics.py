"""Product analytics: one event per interesting thing someone does, streamed into
BigQuery for a Looker Studio report. The same `events` table and row shape as apps/api's
(packages/nest-common/src/analytics.ts); this service records `take_reviewed`, once a
take's review has its score, since only this service knows when that is.

    recorder.record(AnalyticsEvent(kind="take_reviewed", user_id=..., score=82))

`Recorder.record` is fire-and-forget: the write runs in the background, so a slow or
failing BigQuery never holds up or fails the review that triggered it. A failure is
logged with the event's kind (and the job's request id and organization, bound on the
log context), so a gap in the report shows in the logs instead of passing silently.

Seam: `Analytics` is the interface; `BigQueryAnalytics` streams rows into one BigQuery
table through google-cloud-bigquery, authenticated with Application Default Credentials
(the VM's service account in production; no key file). A different destination (a
managed pipeline, another warehouse) is another `Analytics` returned by
`create_analytics`; callers don't change. Off (None) when BIGQUERY_DATASET is unset, so
nothing is written locally or in a project without a dataset.
"""

import asyncio
import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import UUID

from google.api_core.retry import Retry
from google.cloud.bigquery import DEFAULT_RETRY, Client
from pydantic import BaseModel, JsonValue, TypeAdapter

from app.log import log
from app.settings import Settings

# The kinds apps/api records too (ANALYTICS_KINDS in apps/api/src/modules/analytics): one
# spelling for each, across both services.
type AnalyticsKind = Literal["indexed", "take_reviewed", "cut_saved", "published", "call_started"]

# A failed insert is retried (BigQuery's own retry policy) for at most this long: it runs
# in a worker thread, which a long outage shouldn't hold for the default ten minutes.
INSERT_RETRY_SECONDS = 30.0
_RETRY: Retry = DEFAULT_RETRY.with_timeout(INSERT_RETRY_SECONDS)


@dataclass(frozen=True)
class AnalyticsEvent:
    kind: AnalyticsKind
    user_id: UUID | None = None
    template_id: str | None = None
    video_id: str | None = None
    score: int | None = None
    # Anything else worth keeping about the event, stored as the table's JSON column.
    detail: dict[str, JsonValue] | None = None


class Analytics(Protocol):
    async def record(self, event: AnalyticsEvent) -> None: ...


class AnalyticsRefused(Exception):
    """BigQuery answered the insert but refused the row. Carries BigQuery's reasons only,
    never the row, whose user and video ids don't belong in logs."""


class _InsertAll(Protocol):
    """What this uses of google-cloud-bigquery's Client, typed: the client's own signature
    returns bare dicts, which strict type checking can't see into."""

    def insert_rows_json(
        self, table: str, json_rows: Sequence[Mapping[str, JsonValue]], *, retry: Retry
    ) -> Sequence[object]: ...


class _InsertError(BaseModel):
    reason: str = ""
    message: str = ""


class _RefusedRow(BaseModel):
    errors: list[_InsertError]


_REFUSED_ROWS = TypeAdapter(list[_RefusedRow])


class BigQueryAnalytics:
    """Streams each event into `{project}.{dataset}.{table}` (tabledata.insertAll)."""

    def __init__(self, project: str, dataset: str, table: str = "events") -> None:
        self._project = project
        self._table = f"{project}.{dataset}.{table}"
        self._client: _InsertAll | None = None
        self._lock = threading.Lock()

    async def record(self, event: AnalyticsEvent) -> None:
        # The client is blocking (requests): off the event loop, like app/audio.py's upload.
        await asyncio.to_thread(self._insert, _row(event, datetime.now(UTC)))

    def _insert(self, row: dict[str, JsonValue]) -> None:
        # insertAll can answer 200 and still list rows it refused: an error here too.
        refused = _REFUSED_ROWS.validate_python(
            self._bigquery().insert_rows_json(self._table, [row], retry=_RETRY)
        )
        if refused:
            reasons = [
                ": ".join(part for part in (error.reason, error.message) if part)
                for row_errors in refused
                for error in row_errors.errors
            ]
            raise AnalyticsRefused(f"BigQuery refused the event: {'; '.join(reasons)}")

    def _bigquery(self) -> _InsertAll:
        # Built on the first event, in its worker thread, not at startup: finding the
        # credentials may ask the GCE metadata server, which must neither block the event
        # loop nor, if it can't be reached, stop the service from starting.
        with self._lock:
            if self._client is None:
                self._client = Client(project=self._project)
            return self._client


def _row(event: AnalyticsEvent, now: datetime) -> dict[str, JsonValue]:
    """The table's row: the columns apps/api writes, the time in ISO 8601 UTC."""
    return {
        "time": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "kind": event.kind,
        "user_id": str(event.user_id) if event.user_id else None,
        "template_id": event.template_id,
        "video_id": event.video_id,
        "score": event.score,
        "detail": json.dumps(event.detail) if event.detail is not None else None,
    }


class Recorder:
    """Records events in the background, logging (never raising) a failure."""

    def __init__(self, analytics: Analytics | None) -> None:
        self._analytics = analytics
        # The event loop only keeps a weak reference to a task: these keep each write
        # alive until it's done.
        self._pending: set[asyncio.Task[None]] = set()

    def record(self, event: AnalyticsEvent) -> None:
        if self._analytics is None:
            return
        task = asyncio.create_task(self._write(self._analytics, event))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _write(self, analytics: Analytics, event: AnalyticsEvent) -> None:
        try:
            await analytics.record(event)
        except Exception:
            log.exception("failed to record an analytics event", kind=event.kind)


def create_analytics(settings: Settings) -> Analytics | None:
    """The configured analytics, or None when it's off (no BIGQUERY_DATASET). Settings
    refuse a dataset without GOOGLE_CLOUD_PROJECT, so both are set past the check."""
    if not settings.bigquery_dataset or not settings.google_cloud_project:
        return None
    return BigQueryAnalytics(settings.google_cloud_project, settings.bigquery_dataset)
