"""Pure tests of how Gemini's draft of a YouTube post is tidied into one YouTube and
apps/api's contract accept (app/publish_copy.py)."""

import re
from pathlib import Path

import pytest

from app.director import COPY_TIMEOUT_SECONDS
from app.errors import AppError
from app.publish_copy import tidy
from app.schemas import (
    MAX_PUBLISH_HASHTAGS,
    MAX_PUBLISH_TITLE,
    YOUTUBE_DESCRIPTION_MAX_BYTES,
    PublishCopy,
    PublishCopyDraft,
)

# The longest link to a Short the description ends with (packages/contracts publish.ts).
LONGEST_LINK = "https://youtube.com/shorts/" + "x" * 11


def youtube_description(copy: PublishCopy) -> str:
    """The description YouTube gets, put together as the contract's youtubeDescription
    does: the text, the hashtags, then the credits and the original's link."""
    tags = " ".join(f"#{tag}" for tag in copy.hashtags)
    credits = "\n".join(part for part in [copy.credits, LONGEST_LINK] if part)
    return "\n\n".join(part for part in [copy.description, tags, credits] if part)


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
    assert len(copy.title) <= MAX_PUBLISH_TITLE
    assert copy.title.endswith("word")
    # One word longer than the limit is cut where the limit falls.
    assert tidy(draft(title="x" * 200), "Cut title").title == "x" * MAX_PUBLISH_TITLE


def test_an_empty_title_falls_back_to_the_cut_s() -> None:
    assert tidy(draft(title=" <> #shorts "), "My cut").title == "My cut"


def test_hashtags_are_single_words_without_their_hash_once_each() -> None:
    tags = ["#GRWM", "fit check", "grwm", "!!", "सफ़र", "x" * 60, *[f"tag{i}" for i in range(20)]]
    copy = tidy(draft(hashtags=tags), "Cut title")
    assert copy.hashtags[:4] == ["GRWM", "fitcheck", "सफ़र", "x" * 40]
    assert len(copy.hashtags) == MAX_PUBLISH_HASHTAGS


def test_long_descriptions_and_credits_are_shortened() -> None:
    copy = tidy(draft(description="word " * 1_000, credits="word " * 100), "Cut title")
    assert len(copy.description) <= 3_000
    assert len(copy.credits) <= 300


def test_the_credits_end_with_a_line_for_each_stock_picture() -> None:
    lines = ["The chart: Jane Doe on Pexels (https://www.pexels.com/photo/1/)", "<x> " * 100]
    copy = tidy(draft(credits="Original by @creator"), "Cut title", stock_credits=lines)
    original, chart, long = copy.credits.split("\n")
    assert (original, chart) == ("Original by @creator", lines[0])
    assert len(long) <= 140
    assert "<" not in long
    # Twelve long lines still fit.
    many = tidy(draft(credits="x " * 200), "Cut title", stock_credits=["y " * 100] * 12)
    assert len(many.credits) <= 2_000


def test_the_cut_s_own_title_is_cleaned_the_same_way() -> None:
    assert tidy(draft(title=" <> "), "My <best> look #Shorts").title == "My best look"


def test_a_long_non_latin_post_fits_youtube_s_limit_in_bytes() -> None:
    # Within the length limit, but three bytes a character: past YouTube's 5,000 bytes.
    copy = tidy(
        draft(description="あい " * 950, hashtags=["旅行", "グルメ"], credits="作者: マヤ " * 30),
        "Cut title",
    )
    assert len(youtube_description(copy).encode()) <= YOUTUBE_DESCRIPTION_MAX_BYTES
    assert copy.description.endswith("あい")


def test_gemini_answers_before_the_api_stops_waiting_for_the_post() -> None:
    # apps/api waits for this service as long as packages/ai-client's default timeout:
    # past it, Gemini's tokens would be spent on a post nobody gets.
    client = Path(__file__).resolve().parents[3] / "packages/ai-client/src/index.ts"
    found = re.search(r"timeoutMs \?\? ([\d_]+)", client.read_text())
    assert found is not None
    client_seconds = int(found.group(1).replace("_", "")) / 1000
    assert client_seconds - 5 >= COPY_TIMEOUT_SECONDS


def test_with_no_title_left_of_the_cut_s_either_it_takes_the_original_s() -> None:
    copy = tidy(draft(title="#Shorts"), "<>", "Get <ready> with me")
    assert copy.title == "Get ready with me"


def test_with_no_title_left_at_all_gemini_s_post_is_unusable() -> None:
    with pytest.raises(AppError) as raised:
        _ = tidy(draft(title="<>"), "#Shorts", " ")
    assert (raised.value.code, raised.value.params) == (
        "UPSTREAM_UNAVAILABLE",
        {"service": "gemini"},
    )
