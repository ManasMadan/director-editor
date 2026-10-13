"""Turning text into vectors for retrieval, behind one interface.

`ProviderEmbedder` uses any embedding model Pydantic AI knows ("openai:text-embedding-3-
small", Cohere, Voyage, a local server), asked for 1536 dimensions. `HashingEmbedder`
needs no model or key: it hashes words into the same 1536 dimensions, so similar wording
lands close together. It's lexical, not semantic: development and tests only (settings
refuse it in production).

Each embedder has a relevance floor (`min_score`, cosine similarity): passages below it
aren't returned at all, so a question the documents can't answer finds nothing instead
of the least-bad passage. For a provider model it's AI_MIN_RELEVANCE (default 0: the
model judges relevance itself); calibrate it with `bun run --cwd apps/ai evals` for your model.

Changing the dimension means a migration (ai.chunk's vector column) and re-indexing
every document (documents keep their text for that).
"""

import hashlib
import math
import re
from typing import Protocol

from pydantic_ai import Embedder as PydanticEmbedder

from app.db.models import EMBEDDING_DIMENSIONS


class Embedder(Protocol):
    name: str
    min_score: float

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


_WORD = re.compile(r"[\w']+")
# Words too common to say what a text is about (English and Spanish, the catalog's
# languages); without them every question "matches" every passage through "the" and "is".
_STOPWORDS = frozenset(
    """a an the and or but if of to in on at by for with from as is are was were be been
    being do does did have has had i you he she it we they me my your our their this that
    these those what which who whom whose when where why how can could should would will
    may might must not no so than then there here about into over under up out off just
    also only very all any some such own same too el la los las un una unos unas y o pero
    de del al en por para con sin sobre es son fue ser que qué cómo cuál cuándo dónde
    quién se su sus mi mis tu tus lo le les sí muy más menos ya""".split()  # noqa: SIM905 (reads as prose)
)


def terms(text: str) -> list[str]:
    """The words that carry meaning, with plurals folded (refunds → refund).

    A naive plural rule, not a stemmer: this embedder is for development only, and a real
    embedding model handles word forms itself.
    """
    words: list[str] = []
    for match in _WORD.finditer(text.lower()):
        word = match.group()
        if len(word) < 2 or word in _STOPWORDS:
            continue
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        words.append(word)
    return words


class HashingEmbedder:
    name = "hashing"
    # One shared meaningful word between a short question and a passage scores well above
    # this; unrelated texts score 0 (barring a rare hash collision).
    min_score = 0.05

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    @staticmethod
    def _one(text: str) -> list[float]:
        vector = [0.0] * EMBEDDING_DIMENSIONS
        for word in terms(text):
            digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMENSIONS
            vector[index] += 1.0 if digest[4] & 1 else -1.0
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]


class ProviderEmbedder:
    def __init__(self, model: str, min_score: float) -> None:
        self.name = model
        self.min_score = min_score
        self._embedder = PydanticEmbedder(model, settings={"dimensions": EMBEDDING_DIMENSIONS})

    async def embed(self, texts: list[str]) -> list[list[float]]:
        result = await self._embedder.embed_documents(texts)
        return [list(vector) for vector in result.embeddings]


def create_embedder(model: str, min_score: float = 0.0) -> Embedder:
    return HashingEmbedder() if model == "hashing" else ProviderEmbedder(model, min_score)
