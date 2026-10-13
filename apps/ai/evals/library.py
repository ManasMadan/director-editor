"""An in-memory stand-in for the workspace's documents, for the evals: the same chunking,
embedder and relevance floor as Documents (app/documents.py), ranked in Python instead of
pgvector, so the evals need no database."""

import math
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from app.chunking import chunk
from app.documents import Passage
from app.embeddings import Embedder


@dataclass
class _Chunk:
    document_id: UUID
    title: str
    content: str
    vector: list[float]


@dataclass
class Library:
    embedder: Embedder
    _chunks: list[_Chunk] = field(default_factory=list[_Chunk])

    async def add(self, title: str, content: str) -> UUID:
        document_id = uuid4()
        passages = chunk(content)
        vectors = await self.embedder.embed(passages)
        self._chunks += [
            _Chunk(document_id, title, text, vector)
            for text, vector in zip(passages, vectors, strict=True)
        ]
        return document_id

    async def search(self, org_id: UUID, query: str, limit: int = 5) -> list[Passage]:
        [vector] = await self.embedder.embed([query])
        scored = [(_cosine(vector, c.vector), c) for c in self._chunks]
        relevant = [(s, c) for s, c in scored if s >= self.embedder.min_score]
        relevant.sort(key=lambda pair: pair[0], reverse=True)
        return [
            Passage(document_id=c.document_id, title=c.title, content=c.content, score=s)
            for s, c in relevant[:limit]
        ]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norms = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norms if norms else 0.0
