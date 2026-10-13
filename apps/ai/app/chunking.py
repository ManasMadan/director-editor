"""Splitting a document into passages small enough to embed and to quote.

Paragraphs are kept together when they fit; longer ones are split on sentence ends,
and consecutive passages overlap a little so an answer spanning a boundary is still
found.
"""

import re

MAX_CHARS = 1_200
OVERLAP_CHARS = 150

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _pieces(text: str) -> list[str]:
    pieces: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue
        if len(paragraph) <= MAX_CHARS:
            pieces.append(paragraph)
            continue
        for sentence in _SENTENCE_END.split(paragraph):
            # A single sentence longer than a chunk is cut hard.
            pieces.extend(sentence[i : i + MAX_CHARS] for i in range(0, len(sentence), MAX_CHARS))
    return pieces


def _tail(text: str) -> str:
    """The end of a passage, from a word boundary, to start the next one with."""
    tail = text[-OVERLAP_CHARS:]
    return tail[tail.find(" ") + 1 :] if len(text) > OVERLAP_CHARS and " " in tail else tail


def chunk(text: str) -> list[str]:
    chunks: list[str] = []
    current = ""
    for piece in _pieces(text):  # each piece is at most MAX_CHARS
        candidate = f"{current} {piece}" if current else piece
        if len(candidate) <= MAX_CHARS:
            current = candidate
            continue
        chunks.append(current)
        overlap = _tail(current)
        current = f"{overlap} {piece}" if len(overlap) + 1 + len(piece) <= MAX_CHARS else piece
    if current:
        chunks.append(current)
    return chunks
