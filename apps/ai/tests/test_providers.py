"""Model providers, against a local stand-in speaking OpenAI's protocol (tests/fakes.py):
provider embeddings, and the fallback model taking over when the primary fails."""

from uuid import uuid4

import pytest
from pydantic_ai.models.fallback import FallbackModel

from app.assistant import Deps, create_agent, create_model
from app.db.models import EMBEDDING_DIMENSIONS
from app.documents import Passage
from app.embeddings import ProviderEmbedder, create_embedder
from tests.fakes import EmbeddingsRequest, openai_embeddings, openai_unavailable, serve
from tests.test_units import StubDocuments

# Local HTTP servers, so these run with the integration tests.
pytestmark = pytest.mark.integration


@pytest.fixture
def openai(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    return monkeypatch


async def test_a_provider_embeds_in_the_dimensions_the_index_has(
    openai: pytest.MonkeyPatch,
) -> None:
    with serve({"/v1/embeddings": openai_embeddings(EMBEDDING_DIMENSIONS)}) as fake:
        openai.setenv("OPENAI_BASE_URL", f"{fake.url}/v1")
        embedder = create_embedder("openai:text-embedding-3-small", min_score=0.3)
        assert isinstance(embedder, ProviderEmbedder)
        assert (embedder.name, embedder.min_score) == ("openai:text-embedding-3-small", 0.3)
        vectors = await embedder.embed(["refunds", "shipping"])
    assert [len(vector) for vector in vectors] == [EMBEDDING_DIMENSIONS] * 2
    [(path, body)] = fake.received
    assert path == "/v1/embeddings"
    assert EmbeddingsRequest.model_validate_json(body).input == ["refunds", "shipping"]


async def test_the_fallback_model_answers_when_the_primary_is_down(
    openai: pytest.MonkeyPatch,
) -> None:
    with serve({"/v1/responses": openai_unavailable}) as fake:
        openai.setenv("OPENAI_BASE_URL", f"{fake.url}/v1")
        model = create_model("openai:gpt-5", "local:extractive")
        assert isinstance(model, FallbackModel)
        doc = uuid4()
        documents = StubDocuments(
            [Passage(document_id=doc, title="Handbook", content="Refunds take 5 days.", score=1)]
        )
        deps = Deps(org_id=uuid4(), documents=documents)
        result = await create_agent(model).run("How long do refunds take?", deps=deps)
    # The primary was asked first each time (searching, then answering) and failed; the
    # fallback answered both times.
    assert [path for path, _ in fake.received] == ["/v1/responses"] * 2
    assert result.output == "From “Handbook”: Refunds take 5 days."
    assert deps.sources == {doc: "Handbook"}
