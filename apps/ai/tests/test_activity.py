"""Activity lines and what keeps secrets out of every line: the shape the Node services
write too, the user a job ran for, and the redaction a mistake can't get past."""

import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import structlog
from structlog.testing import capture_logs

from app.activity import log_activity, outcome_of
from app.log import CENSOR, redact
from app.queues import JobLike
from app.worker import run_job


class Job:
    def __init__(self) -> None:
        self.id: str | None = "job-1"
        self.name = "plan"
        self.data: object = {}
        self.attemptsMade = 1


def test_a_line_names_the_activity_its_outcome_and_what_it_was_about() -> None:
    user = uuid4()
    with capture_logs() as logs:
        log_activity(
            "director.take_reviewed",
            target={"takeId": "t-1", "score": 82, "inPlace": True},
            duration_ms=12.6,
            user_id=user,
        )
    assert logs == [
        {
            "event": "activity",
            "log_level": "info",
            "activity": "director.take_reviewed",
            "actor": {"userId": str(user)},
            "outcome": "ok",
            # Whole numbers stay whole, as the Node services write them.
            "target": {"takeId": "t-1", "score": 82, "inPlace": True},
            "durationMs": 13,
        }
    ]


def test_a_line_is_for_the_user_on_the_log_context_and_a_failure_is_a_warning() -> None:
    with structlog.contextvars.bound_contextvars(userId="u-1"), capture_logs() as logs:
        log_activity("director.indexed", outcome="failed", reason="DIRECTOR_ANALYSIS_FAILED")
    assert logs == [
        {
            "event": "activity",
            "log_level": "warning",
            "activity": "director.indexed",
            "actor": {"userId": "u-1"},
            "outcome": "failed",
            "reason": "DIRECTOR_ANALYSIS_FAILED",
        }
    ]


def test_a_run_out_of_tokens_was_refused_and_any_other_end_failed() -> None:
    assert outcome_of("AI_BUDGET_EXCEEDED") == "refused"
    assert outcome_of("DIRECTOR_REVIEW_FAILED") == "failed"


async def test_a_job_writes_its_line_however_it_ends() -> None:
    job: JobLike = Job()

    async def works() -> None:
        return None

    async def breaks() -> None:
        raise RuntimeError("Gemini is down")

    with capture_logs() as logs:
        await run_job(job, False, works)
        with pytest.raises(RuntimeError):
            await run_job(job, True, breaks)
    done, failed = logs
    assert done["activity"] == "job.finished"
    assert done["outcome"] == "ok"
    assert done["target"] == {"queue": "ai-director", "job": "plan", "jobId": "job-1", "attempt": 2}
    assert failed["outcome"] == "failed"
    assert failed["reason"] == "RuntimeError"
    assert failed["target"] == {
        "queue": "ai-director",
        "job": "plan",
        "jobId": "job-1",
        "attempt": 2,
        "final": True,
    }


APP_ROOT = Path(__file__).parent.parent


def test_no_line_carries_a_secret_or_a_signed_url() -> None:
    # Logged as production logs, in a process of its own (tests/log_secrets.py says why).
    line = subprocess.run(
        [sys.executable, "-m", "tests.log_secrets"],
        cwd=APP_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout
    secrets = (
        "secret-token",
        "1//refresh",
        "123456",
        "hunter22",
        "deadbeef",
        "X-Amz-Credential",
        "cafe",
    )
    for secret in secrets:
        assert secret not in line
    assert '"actor": {"email": "ada@example.com"}' in line
    assert f'"sourceUrl": "https://storage.example.com/t.webm?{CENSOR}"' in line
    assert '"kept": 1' in line


def test_redaction_keeps_what_isn_t_secret_and_stops_at_a_depth() -> None:
    deep: dict[str, object] = {"token": "deepest"}
    for _ in range(10):
        deep = {"inner": deep}
    event = redact(
        None,
        "info",
        {
            "url": "https://youtube.com/shorts/abc?feature=share",
            "deep": deep,
            "n": 3,
            "Authorization": "Bearer abc",
            "items": ({"password": "hunter22"}, "plain"),
        },
    )
    assert event["Authorization"] == CENSOR
    assert event["items"] == [{"password": CENSOR}, "plain"]
    assert event["url"] == "https://youtube.com/shorts/abc?feature=share"
    assert event["n"] == 3
    assert "deepest" in json.dumps(event["deep"])
