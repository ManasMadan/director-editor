"""Product analytics (app/analytics.py): off without a dataset, every write in the
background and never the caller's failure, and the BigQuery seam against a local
stand-in that speaks tabledata.insertAll (tests/fakes.py), the same rows apps/api writes."""

import asyncio
import json
import os
from datetime import datetime
from unittest.mock import patch
from uuid import uuid4

import pytest
from google.api_core.exceptions import BadRequest
from pydantic import ValidationError
from structlog.testing import capture_logs

from app import analytics
from app.analytics import (
    AnalyticsEvent,
    AnalyticsRefused,
    BigQueryAnalytics,
    Recorder,
    create_analytics,
)
from app.settings import Settings
from tests.fakes import (
    BIGQUERY_DATASET,
    BIGQUERY_PROJECT,
    INSERT_ALL,
    Fake,
    Reply,
    bigquery_client,
    bigquery_inserted,
    inserted_rows,
    serve,
)
from tests.tokens import SECRET

EVENT = AnalyticsEvent(kind="take_reviewed", user_id=uuid4(), video_id="dQw4w9WgXcQ", score=82)


def _settings(**env: str) -> Settings:
    base = {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": SECRET,
    }
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate({**base, **env})


# ------------------------------------------------------------------------ configuration


def test_analytics_is_off_without_a_dataset() -> None:
    assert create_analytics(_settings()) is None
    assert create_analytics(_settings(GOOGLE_CLOUD_PROJECT="p")) is None


def test_a_dataset_and_its_project_turn_analytics_on() -> None:
    # Building it never reaches Google: the client (and ADC) waits for the first event.
    found = create_analytics(_settings(BIGQUERY_DATASET="director", GOOGLE_CLOUD_PROJECT="p"))
    assert isinstance(found, BigQueryAnalytics)


def test_a_dataset_without_a_project_to_write_it_in_fails_at_boot() -> None:
    with pytest.raises(ValidationError, match="BIGQUERY_DATASET needs GOOGLE_CLOUD_PROJECT"):
        _settings(BIGQUERY_DATASET="director")


@pytest.mark.parametrize("name", ["director.events", "director-events", "a" * 1025])
def test_a_dataset_name_bigquery_would_refuse_is_refused(name: str) -> None:
    with pytest.raises(ValidationError):
        _settings(BIGQUERY_DATASET=name, GOOGLE_CLOUD_PROJECT="p")


# ------------------------------------------------------------------------ the recorder


class StandIn:
    """An Analytics that holds each write until the test lets it finish (or fail)."""

    def __init__(self, error: Exception | None = None) -> None:
        self.release = asyncio.Event()
        self.done = asyncio.Event()
        self.events: list[AnalyticsEvent] = []
        self._error = error

    async def record(self, event: AnalyticsEvent) -> None:
        await self.release.wait()
        self.done.set()
        if self._error:
            raise self._error
        self.events.append(event)


def test_recording_with_analytics_off_does_nothing() -> None:
    # No running loop needed either: nothing is scheduled.
    Recorder(None).record(EVENT)


async def test_a_write_runs_in_the_background_and_never_holds_up_the_caller() -> None:
    stand_in = StandIn()
    Recorder(stand_in).record(EVENT)
    # Back in the caller while the write is still waiting.
    assert stand_in.events == []
    stand_in.release.set()
    await asyncio.wait_for(stand_in.done.wait(), timeout=5)
    await asyncio.sleep(0)
    assert stand_in.events == [EVENT]


async def test_a_failed_write_is_logged_with_its_kind_never_raised() -> None:
    stand_in = StandIn(RuntimeError("insert refused"))
    with capture_logs() as logs:
        Recorder(stand_in).record(EVENT)
        stand_in.release.set()
        await asyncio.wait_for(stand_in.done.wait(), timeout=5)
        for _ in range(10):
            if logs:
                break
            await asyncio.sleep(0)
    assert [(line["event"], line["kind"], line["log_level"]) for line in logs] == [
        ("failed to record an analytics event", "take_reviewed", "error")
    ]


# ------------------------------------------------------------------------ BigQuery


def _analytics(fake: Fake, monkeypatch: pytest.MonkeyPatch) -> BigQueryAnalytics:
    """BigQueryAnalytics whose client (built on its first event) talks to `fake`."""
    monkeypatch.setattr(analytics, "Client", bigquery_client(fake))
    return BigQueryAnalytics(BIGQUERY_PROJECT, BIGQUERY_DATASET)


@pytest.mark.integration
async def test_an_event_is_streamed_into_the_events_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with serve({INSERT_ALL: bigquery_inserted}) as fake:
        recorder = _analytics(fake, monkeypatch)
        await recorder.record(EVENT)
        await recorder.record(
            AnalyticsEvent(kind="published", detail={"platform": "shorts", "seconds": 12})
        )
    first, second = inserted_rows(fake)
    assert {key: value for key, value in first.items() if key != "time"} == {
        "kind": "take_reviewed",
        "user_id": str(EVENT.user_id),
        "template_id": None,
        "video_id": "dQw4w9WgXcQ",
        "score": 82,
        "detail": None,
    }
    # ISO 8601 in UTC, to the millisecond, the way apps/api writes it.
    time = first["time"]
    assert isinstance(time, str)
    assert time.endswith("Z")
    assert datetime.fromisoformat(time).utcoffset() is not None
    assert {key: value for key, value in second.items() if key != "time"} == {
        "kind": "published",
        "user_id": None,
        "template_id": None,
        "video_id": None,
        "score": None,
        # The table's JSON column takes a JSON string.
        "detail": json.dumps({"platform": "shorts", "seconds": 12}),
    }


@pytest.mark.integration
async def test_rows_bigquery_refuses_name_each_reason_and_never_the_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A 200 that still lists the rows it dropped (a partial failure), as insertAll reports it.
    def refused(_body: bytes) -> Reply:
        return 200, {
            "kind": "bigquery#tableDataInsertAllResponse",
            "insertErrors": [
                {
                    "index": 0,
                    "errors": [
                        {
                            "reason": "invalid",
                            "location": "user_id",
                            "message": "no such field: user_id.",
                        },
                        {"reason": "stopped", "location": "", "message": ""},
                    ],
                }
            ],
        }

    with serve({INSERT_ALL: refused}) as fake, pytest.raises(AnalyticsRefused) as error:
        await _analytics(fake, monkeypatch).record(EVENT)
    message = str(error.value)
    assert message == "BigQuery refused the event: invalid: no such field: user_id.; stopped"
    assert str(EVENT.user_id) not in message


@pytest.mark.integration
async def test_an_insert_bigquery_rejects_outright_raises_for_the_recorder_to_log(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def rejected(_body: bytes) -> Reply:
        return 400, {"error": {"code": 400, "message": "no such table", "status": "INVALID"}}

    with serve({INSERT_ALL: rejected}) as fake, pytest.raises(BadRequest):
        await _analytics(fake, monkeypatch).record(EVENT)
