"""A take's review as Gemini answers it, made into one that fits TakeReview
(app/take_review.py): a review that runs long is trimmed, never failed."""

import pytest
from pydantic import ValidationError

from app.schemas import (
    MAX_INDEX_MOMENTS,
    MAX_INDEX_THINGS,
    MAX_INDEX_WORDS,
    REASON_MAX_LENGTH,
    TakeReviewDraft,
)
from app.take_review import MAX_FEEDBACK, MAX_VISIBLE, repair_review

QUALITY = {"sharpness": "sharp", "shake": "steady", "exposure": "good", "audio": "clear"}


def draft(**fields: object) -> TakeReviewDraft:
    return TakeReviewDraft.model_validate(
        {
            "bestStartSeconds": 1.0,
            "bestEndSeconds": 4.0,
            "score": 80,
            "feedback": "Nice and steady; smile at the end.",
            "reason": "You held the smile.",
            "index": {
                "visible": "A man at a desk.",
                "things": ["desk"],
                "transcript": [],
                "moments": [],
                "quality": QUALITY,
            },
            **fields,
        }
    )


def test_a_review_that_fits_is_kept_as_it_is() -> None:
    review = repair_review(draft())
    assert (review.bestStartSeconds, review.bestEndSeconds, review.score) == (1.0, 4.0, 80)
    assert review.feedback == "Nice and steady; smile at the end."
    assert review.index is not None
    assert review.index.things == ["desk"]


def test_a_review_that_runs_long_is_trimmed_at_a_word() -> None:
    words = [{"text": "word", "startSeconds": 0.1, "endSeconds": 0.2}] * (MAX_INDEX_WORDS + 5)
    moment = {"kind": "smile", "atSeconds": 70, "note": "a smile " * 40}
    review = repair_review(
        draft(
            bestStartSeconds=-1,
            bestEndSeconds=75,
            score=140,
            feedback="really " * 60,
            reason="because " * 40,
            index={
                "visible": "a desk " * 200,
                "things": [f"thing {n}" for n in range(MAX_INDEX_THINGS + 10)] + ["  "],
                "transcript": [{"text": " ", "startSeconds": 0, "endSeconds": 1}, *words],
                "moments": [moment] * (MAX_INDEX_MOMENTS + 3),
                "quality": QUALITY,
            },
        )
    )
    assert (review.bestStartSeconds, review.bestEndSeconds, review.score) == (0, 60, 100)
    assert len(review.feedback) <= MAX_FEEDBACK
    assert review.feedback.endswith("really")
    assert len(review.reason) <= REASON_MAX_LENGTH
    assert review.index is not None
    assert len(review.index.visible) <= MAX_VISIBLE
    assert len(review.index.things) == MAX_INDEX_THINGS
    assert len(review.index.transcript) == MAX_INDEX_WORDS
    assert review.index.transcript[0].text == "word"
    assert len(review.index.moments) == MAX_INDEX_MOMENTS
    assert review.index.moments[0].atSeconds == 60


def test_a_photo_keeps_no_best_part() -> None:
    review = repair_review(draft(bestStartSeconds=None, bestEndSeconds=None))
    assert (review.bestStartSeconds, review.bestEndSeconds) == (None, None)


def test_feedback_that_is_only_spaces_fails_rather_than_being_stored() -> None:
    with pytest.raises(ValidationError):
        _ = repair_review(draft(feedback="   "))
