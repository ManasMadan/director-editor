"""How this service adds and retries its jobs (app/queues.py): with the queue's jittered
backoff, which Python's bullmq doesn't compute itself."""

from app.queues import DIRECTOR, JITTERED, REVIEW, SETTINGS, jittered_backoff, job_options


def test_a_review_is_added_with_the_reviews_queue_s_jittered_backoff() -> None:
    options = job_options(REVIEW, "take-1")
    assert options.get("jobId") == "take-1"
    assert options.get("attempts") == SETTINGS[REVIEW].options.attempts == 6
    assert options.get("backoff") == {"type": JITTERED, "delay": 15_000}
    assert job_options(DIRECTOR, "plan-1").get("backoff") == {"type": JITTERED, "delay": 5_000}


def test_each_retry_waits_twice_as_long_as_the_last_shortened_at_random_by_up_to_half() -> None:
    longest = jittered_backoff(REVIEW, draw=lambda: 0.0)
    shortest = jittered_backoff(REVIEW, draw=lambda: 0.999_999)
    assert [longest(attempt, JITTERED, None, None) for attempt in range(1, 6)] == [
        15_000,
        30_000,
        60_000,
        120_000,
        240_000,
    ]
    assert [shortest(attempt, JITTERED, None, None) for attempt in (1, 5)] == [7_500, 120_000]
    # Jobs that failed together come back spread out.
    spread = {jittered_backoff(REVIEW)(3, JITTERED, None, None) for _ in range(20)}
    assert len(spread) > 1
    assert all(30_000 <= wait <= 60_000 for wait in spread)
