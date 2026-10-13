from itertools import pairwise

from app.chunking import MAX_CHARS, OVERLAP_CHARS, chunk


def test_short_text_is_one_chunk() -> None:
    assert chunk("Hello there.\n\nSecond paragraph.") == ["Hello there. Second paragraph."]


def test_empty_text_has_no_chunks() -> None:
    assert chunk("   \n\n  ") == []


def test_long_text_splits_within_the_limit_with_overlap() -> None:
    sentences = [f"Sentence number {i} talks about topic {i % 7}." for i in range(300)]
    text = " ".join(sentences)
    chunks = chunk(text)
    assert len(chunks) > 5
    assert all(len(c) <= MAX_CHARS for c in chunks)
    # Consecutive chunks share their boundary text, so nothing falls between them.
    for previous, following in pairwise(chunks):
        assert previous[-OVERLAP_CHARS // 2 :].split()[-1] in following
    # Every sentence ends up somewhere.
    joined = " ".join(chunks)
    assert all(s in joined for s in sentences)


def test_a_huge_sentence_is_cut_hard() -> None:
    word = "x" * 5_000
    chunks = chunk(word)
    assert all(len(c) <= MAX_CHARS for c in chunks)
    assert "".join(c.replace(" ", "") for c in chunks).count("x") >= 5_000
