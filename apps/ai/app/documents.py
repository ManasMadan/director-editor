"""A workspace's documents: stored, split into passages, embedded, and searched.

Adding a document stores its text and queues indexing (app/worker.py), so a large text
never holds up the request. Search is nearest-neighbour over the passages' embeddings,
limited to the caller's organization by row-level security.
"""

from dataclasses import dataclass
from uuid import UUID

# LangGraph ships without type stubs.
from langgraph.graph.state import CompiledStateGraph  # pyright: ignore[reportMissingTypeStubs]
from pydantic_ai import UsageLimitExceeded
from pydantic_ai.usage import RunUsage, UsageLimits
from redis.asyncio import Redis
from sqlalchemy import Float, delete, func, select, update

from app.chunking import chunk
from app.contracts.realtime_message import DocumentsChanged
from app.db.models import Document, DocumentChunk
from app.db.session import tenant
from app.embeddings import Embedder
from app.errors import AppError
from app.log import log
from app.queues import IngestQueue
from app.realtime import publish_to_org
from app.settings import Settings
from app.summaries import SummaryState, build_summary_graph, local_summarizer, summarize
from app.usage import reserve, settle

# Passages sent to the embedding model per request.
EMBED_BATCH = 64
# What screens showing the documents are told when one is added, indexed or removed.
CHANGED = DocumentsChanged(type="documents.changed")


@dataclass(frozen=True)
class Passage:
    document_id: UUID
    title: str
    content: str
    score: float


@dataclass(frozen=True)
class Summaries:
    """Summaries are written when a model is configured (see app/summaries.py)."""

    graph: CompiledStateGraph[SummaryState]
    model_name: str
    monthly_tokens: int
    tokens_per_run: int


@dataclass(frozen=True)
class Documents:
    embedder: Embedder
    queue: IngestQueue
    redis: Redis
    summaries: Summaries | None = None

    async def create(
        self, org_id: UUID, user_id: UUID, title: str, content: str, request_id: str | None
    ) -> Document:
        async with tenant(org_id) as session:
            document = Document(
                org_id=org_id,
                created_by=user_id,
                title=title,
                content=content,
                updated_at=func.now(),
            )
            session.add(document)
            await session.flush()
            await session.refresh(document)
        await self.queue.add("ingest", document.id, org_id, request_id=request_id, user_id=user_id)
        await publish_to_org(self.redis, org_id, CHANGED)
        return document

    async def list(self, org_id: UUID) -> list[Document]:
        async with tenant(org_id) as session:
            rows = await session.scalars(
                select(Document)
                .where(Document.org_id == org_id)
                .order_by(Document.created_at.desc())
            )
            return list(rows)

    async def delete(self, org_id: UUID, document_id: UUID) -> None:
        async with tenant(org_id) as session:
            deleted = await session.scalar(
                delete(Document)
                .where(Document.id == document_id, Document.org_id == org_id)
                .returning(Document.id)
            )
            if deleted is None:
                raise AppError("DOCUMENT_NOT_FOUND")
        await publish_to_org(self.redis, org_id, CHANGED)

    async def index(
        self,
        org_id: UUID,
        document_id: UUID,
        *,
        request_id: str | None = None,
        user_id: UUID | None = None,
    ) -> None:
        """Splits and embeds a document (the ingest job). Safe to run again: it replaces
        the passages it wrote before."""
        async with tenant(org_id) as session:
            document = await session.get(Document, document_id)
            if not document:
                return  # deleted before it was indexed
            document.status = "indexing"
            content = document.content
        try:
            passages = chunk(content)
            vectors: list[list[float]] = []
            for start in range(0, len(passages), EMBED_BATCH):
                vectors.extend(await self.embedder.embed(passages[start : start + EMBED_BATCH]))
        except Exception:
            log.exception("indexing failed", document_id=str(document_id))
            async with tenant(org_id) as session:
                await session.execute(
                    update(Document)
                    .where(Document.id == document_id)
                    .values(
                        status="failed", error="DOCUMENT_INDEXING_FAILED", updated_at=func.now()
                    )
                )
            await publish_to_org(self.redis, org_id, CHANGED)
            raise
        async with tenant(org_id) as session:
            await session.execute(
                delete(DocumentChunk).where(DocumentChunk.document_id == document_id)
            )
            session.add_all(
                DocumentChunk(
                    document_id=document_id,
                    org_id=org_id,
                    ordinal=ordinal,
                    content=text,
                    embedding=vector,
                )
                for ordinal, (text, vector) in enumerate(zip(passages, vectors, strict=True))
            )
            await session.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(
                    status="ready", error=None, chunk_count=len(passages), updated_at=func.now()
                )
            )
        await publish_to_org(self.redis, org_id, CHANGED)
        if self.summaries:
            await self.queue.add(
                "summarize", document_id, org_id, request_id=request_id, user_id=user_id
            )

    async def summarize(self, org_id: UUID, document_id: UUID, user_id: UUID | None) -> None:
        """Writes the document's summary (the summarize job). A workspace past its monthly
        allowance simply gets no summary; answering questions matters more."""
        if not self.summaries:
            return
        reservation = await reserve(
            org_id,
            user_id,
            "summary",
            self.summaries.model_name,
            most=self.summaries.tokens_per_run,
            monthly=self.summaries.monthly_tokens,
        )
        if reservation is None:
            log.info("skipping a summary: monthly budget used", document_id=str(document_id))
            return
        usage = RunUsage()
        try:
            async with tenant(org_id) as session:
                passages = list(
                    await session.scalars(
                        select(DocumentChunk.content)
                        .where(DocumentChunk.document_id == document_id)
                        .order_by(DocumentChunk.ordinal)
                    )
                )
            summary = await summarize(
                self.summaries.graph,
                passages,
                usage,
                UsageLimits(total_tokens_limit=reservation.tokens),
            )
        except UsageLimitExceeded:
            # The document needs more than this run may spend: running the job again would
            # only spend it again, so it ends here, without a summary.
            log.info("skipping a summary: over the run's token limit", document_id=str(document_id))
            return
        finally:
            await settle(reservation, usage.input_tokens, usage.output_tokens)
        async with tenant(org_id) as session:
            await session.execute(
                update(Document)
                .where(Document.id == document_id)
                .values(summary=summary or None, updated_at=func.now())
            )
        await publish_to_org(self.redis, org_id, CHANGED)

    async def search(self, org_id: UUID, query: str, limit: int = 5) -> list[Passage]:
        [vector] = await self.embedder.embed([query])
        # pgvector's cosine distance (what its untyped `cosine_distance` comparator emits).
        distance = DocumentChunk.embedding.op("<=>", return_type=Float())(vector)
        async with tenant(org_id) as session:
            rows = await session.execute(
                select(DocumentChunk.document_id, Document.title, DocumentChunk.content, distance)
                .join(Document, Document.id == DocumentChunk.document_id)
                .where(
                    DocumentChunk.org_id == org_id,
                    Document.status == "ready",
                    distance <= 1 - self.embedder.min_score,
                )
                .order_by(distance)
                .limit(limit)
            )
            return [
                Passage(document_id=row[0], title=row[1], content=row[2], score=1 - float(row[3]))
                for row in rows
            ]


def create_summaries(settings: Settings) -> Summaries | None:
    if not settings.model:
        return None
    model = local_summarizer() if settings.model == "local:extractive" else settings.model
    return Summaries(
        graph=build_summary_graph(model),
        model_name=settings.model,
        monthly_tokens=settings.monthly_tokens_per_org,
        tokens_per_run=settings.tokens_per_run,
    )
