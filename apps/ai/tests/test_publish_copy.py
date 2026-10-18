"""Pure tests of how Gemini's draft of a YouTube post is tidied into one YouTube and
apps/api's contract accept (app/publish_copy.py)."""

from app.publish_copy import MAX_HASHTAGS, MAX_TITLE, tidy
from app.schemas import PublishCopyDraft


def draft(**fields: object) -> PublishCopyDraft:
    base: dict[str, object] = {
        "title": "My look",
        "description": "Three outfits, one mirror.",
        "hashtags": ["grwm"],
        "credits": "Inspired by Maya's Short.",
    }
    return PublishCopyDraft.model_validate({**base, **fields})


def test_a_draft_that_fits_is_kept_as_it_is() -> None:
    copy = tidy(draft(), "Cut title")
    assert copy.model_dump() == {
        "title": "My look",
        "description": "Three outfits, one mirror.",
        "hashtags": ["grwm"],
        "credits": "Inspired by Maya's Short.",
    }


def test_angle_brackets_and_shorts_tags_are_taken_out() -> None:
    copy = tidy(
        draft(
            title="My <best> look #Shorts",
            description="One <b>mirror</b>.\nTwo lines.",
            credits="By <Maya>",
        ),
        "Cut title",
    )
    assert (copy.title, copy.description, copy.credits) == (
        "My best look",
        "One bmirror/b.\nTwo lines.",
        "By Maya",
    )


def test_a_long_title_ends_at_a_word() -> None:
    title = "word " * 40
    copy = tidy(draft(title=title), "Cut title")
    assert len(copy.title) <= MAX_TITLE
    assert copy.title.endswith("word")
    # One word longer than the limit is cut where the limit falls.
    assert tidy(draft(title="x" * 200), "Cut title").title == "x" * MAX_TITLE


def test_an_empty_title_falls_back_to_the_cut_s() -> None:
    assert tidy(draft(title=" <> #shorts "), "My cut").title == "My cut"


def test_hashtags_are_single_words_without_their_hash_once_each() -> None:
    tags = ["#GRWM", "fit check", "grwm", "!!", "सफ़र", "x" * 60, *[f"tag{i}" for i in range(20)]]
    copy = tidy(draft(hashtags=tags), "Cut title")
    assert copy.hashtags[:4] == ["GRWM", "fitcheck", "सफ़र", "x" * 40]
    assert len(copy.hashtags) == MAX_HASHTAGS


def test_long_descriptions_and_credits_are_shortened() -> None:
    copy = tidy(draft(description="word " * 1_000, credits="word " * 100), "Cut title")
    assert len(copy.description) <= 3_000
    assert len(copy.credits) <= 300
