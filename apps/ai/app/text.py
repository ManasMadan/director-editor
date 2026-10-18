"""Cutting Gemini's text to a field's length, at a word, instead of failing on it."""


def at_a_word(text: str, cut: str) -> str:
    """`cut` (the start of `text`), ending at a word when there's one to end at."""
    if cut == text:
        return text
    head, space, _ = cut.rpartition(" ")
    return head.rstrip(" ,;:-") if space and head else cut


def shorten(text: str, limit: int) -> str:
    """At most `limit` characters, ending at a word when there's one to end at."""
    return at_a_word(text, text[:limit])
