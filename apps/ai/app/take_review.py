"""A take's review, as Gemini answers it (`TakeReviewDraft`), made into a `TakeReview`.

The draft carries no list bounds, no defaults and few text or number bounds, so the
schema Vertex AI is sent keeps to what it accepts (app/schemas.py says why) and a review
that runs a little long costs a trim instead of a failed take: text is cut at a word,
lists are cut to their limits, times and the score are clamped into range, and blank
entries are dropped. The result is validated against `TakeReview`, so anything a trim
can't make whole (a feedback that's only spaces) fails loudly rather than being stored.
"""

from app.schemas import (
    MAX_INDEX_MOMENTS,
    MAX_INDEX_THINGS,
    MAX_INDEX_WORDS,
    MAX_SHOT_SECONDS,
    REASON_MAX_LENGTH,
    SpokenWord,
    SpokenWordDraft,
    TakeIndex,
    TakeIndexDraft,
    TakeMoment,
    TakeMomentDraft,
    TakeReview,
    TakeReviewDraft,
)
from app.text import shorten

# TakeReview's and TakeIndex's own bounds (app/schemas.py).
MAX_FEEDBACK = 300
MAX_VISIBLE = 800
MAX_WORD = 60
MAX_MOMENT_NOTE = 120
MAX_THING = 60
MIN_BEST_END_SECONDS = 0.1


def repair_review(draft: TakeReviewDraft) -> TakeReview:
    """The review, trimmed and clamped into `TakeReview`'s bounds."""
    return TakeReview(
        bestStartSeconds=_seconds(draft.bestStartSeconds, 0),
        bestEndSeconds=_seconds(draft.bestEndSeconds, MIN_BEST_END_SECONDS),
        score=max(0, min(draft.score, 100)),
        feedback=shorten(draft.feedback.strip(), MAX_FEEDBACK),
        reason=shorten(draft.reason.strip(), REASON_MAX_LENGTH),
        index=_index(draft.index),
    )


def _seconds(value: float | None, low: float) -> float | None:
    return None if value is None else _clamp(value, low)


def _clamp(value: float, low: float = 0) -> float:
    return max(low, min(value, MAX_SHOT_SECONDS))


def _index(draft: TakeIndexDraft) -> TakeIndex:
    things = dict.fromkeys(
        shorten(thing.strip(), MAX_THING) for thing in draft.things if thing.strip()
    )
    return TakeIndex(
        visible=shorten(draft.visible.strip(), MAX_VISIBLE),
        things=list(things)[:MAX_INDEX_THINGS],
        transcript=[_word(word) for word in draft.transcript if word.text.strip()][
            :MAX_INDEX_WORDS
        ],
        moments=[_moment(moment) for moment in draft.moments[:MAX_INDEX_MOMENTS]],
        quality=draft.quality,
    )


def _word(draft: SpokenWordDraft) -> SpokenWord:
    return SpokenWord(
        text=shorten(draft.text.strip(), MAX_WORD),
        startSeconds=_clamp(draft.startSeconds),
        endSeconds=_clamp(draft.endSeconds),
    )


def _moment(draft: TakeMomentDraft) -> TakeMoment:
    return TakeMoment(
        kind=draft.kind,
        atSeconds=_clamp(draft.atSeconds),
        note=shorten(draft.note.strip(), MAX_MOMENT_NOTE),
    )
