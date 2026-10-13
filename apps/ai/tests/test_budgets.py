"""Token budgets against the real ledger (ai.usage): every run records what it spent,
however it ends, and reservations keep concurrent runs inside the monthly allowance."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import replace
from uuid import UUID

import anyio
import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel

from app.assistant import Assistant, AssistantEvent, create_agent
from app.documents import Documents, Summaries
from app.summaries import COMBINE, build_summary_graph, local_summarizer
from app.usage import reserve
from tests.support import as_org, documents_of, headers, index_all, new_org, on_app_loop

pytestmark = pytest.mark.integration

MONTHLY = 2_000_000


def spent(org: UUID, feature: str = "assistant") -> int:
    [(total,)] = as_org(
        org,
        "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage WHERE feature = %s",
        (feature,),
    )
    assert isinstance(total, int)
    return total


def _searched(messages: list[ModelMessage]) -> bool:
    return any(
        isinstance(part, ToolReturnPart)
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
    )


def model(after_search: Callable[[], AsyncIterator[str]]) -> Model:
    """Searches first, like the local model; what it does next is the test's."""

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if not _searched(messages):
            yield {0: DeltaToolCall(name="search_documents", json_args=json.dumps({"query": "q"}))}
            return
        async for text in after_search():
            yield text

    async def respond(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart("unused")])

    return FunctionModel(respond, stream_function=stream, model_name="test")


async def _one_word_then_hang() -> AsyncIterator[str]:
    yield "Refunds "
    await anyio.sleep_forever()


async def _long_answer() -> AsyncIterator[str]:
    for word in ["Refunds"] * 200:
        yield f"{word} "


async def _provider_fails() -> AsyncIterator[str]:
    raise RuntimeError("the provider went away")
    yield ""  # a generator, but it fails before its first word


def assistant_with(
    client: TestClient, answer: Callable[[], AsyncIterator[str]], per_run: int
) -> Assistant:
    from app.main import services

    return Assistant(
        create_agent(model(answer)),
        services().documents,
        model_name="test",
        monthly_tokens=MONTHLY,
        tokens_per_run=per_run,
    )


def events_of(client: TestClient, assistant: Assistant, org: UUID, user: UUID) -> list[str]:
    async def run() -> list[str]:
        reservation = await assistant.reserve(org, user)
        return [event.event.type async for event in assistant.answer(reservation, "Refunds?")]

    return on_app_loop(client, run)


def the_assistant() -> Assistant:
    from app.main import services

    assistant = services().assistant
    assert assistant is not None
    return assistant


def with_a_document(
    client: TestClient, content: str = "Refunds take five business days to arrive."
) -> tuple[UUID, UUID]:
    org, user = new_org()
    client.post(
        "/v1/documents", json={"title": "Handbook", "content": content}, headers=headers(org, user)
    )
    index_all(client, org)
    return org, user


def test_an_answer_the_client_abandons_is_still_counted(client: TestClient) -> None:
    org, user = with_a_document(client)
    assistant = the_assistant()

    async def first_event_then_leave() -> AssistantEvent:
        reservation = await assistant.reserve(org, user)
        stream = assistant.answer(reservation, "How long do refunds take?")
        first = await anext(stream)
        await stream.aclose()
        return first

    first = on_app_loop(client, first_event_then_leave)
    assert first.event.type == "text"
    # What it spent, not nothing and not the whole reservation.
    assert 0 < spent(org) < 20_000


def test_an_answer_cancelled_mid_stream_is_still_counted(client: TestClient) -> None:
    org, user = with_a_document(client)
    assistant = assistant_with(client, _one_word_then_hang, per_run=20_000)

    async def cancelled_after_the_first_word() -> list[str]:
        seen: list[str] = []
        reservation = await assistant.reserve(org, user)
        # How Starlette stops a stream when the client disconnects: the scope is cancelled
        # while the answer waits for the model.
        with anyio.CancelScope() as scope:
            async for event in assistant.answer(reservation, "Refunds?"):
                seen.append(event.event.type)
                scope.cancel()
        return seen

    seen = on_app_loop(client, cancelled_after_the_first_word)
    assert seen == ["text"]
    assert 0 < spent(org) < 20_000


def test_an_answer_stopped_at_the_run_limit_is_counted(client: TestClient) -> None:
    org, user = with_a_document(client)
    assistant = assistant_with(client, _long_answer, per_run=150)
    assert events_of(client, assistant, org, user)[-1] == "error"
    assert spent(org) > 0


def test_a_failed_answer_is_counted(client: TestClient) -> None:
    org, user = with_a_document(client)
    assistant = assistant_with(client, _provider_fails, per_run=20_000)
    assert events_of(client, assistant, org, user) == ["error"]
    # The search request before the failure used tokens.
    assert 0 < spent(org) < 20_000


def test_a_run_may_spend_only_what_is_left_of_the_month(client: TestClient) -> None:
    org, user = with_a_document(client)
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'assistant', 'x', %s, 0)",
        (org, MONTHLY - 20),
    )
    assert events_of(client, the_assistant(), org, user)[-1] == "error"


def test_concurrent_reservations_share_the_allowance(client: TestClient) -> None:
    org, user = new_org()

    async def three_at_once() -> list[int | None]:
        async def one() -> int | None:
            reservation = await reserve(org, user, "assistant", "m", most=20_000, monthly=30_000)
            return reservation.tokens if reservation else None

        return list(await asyncio.gather(one(), one(), one()))

    granted = on_app_loop(client, three_at_once)
    assert sorted(granted, key=lambda tokens: tokens or 0) == [None, 10_000, 20_000]
    assert spent(org) == 30_000


def documents_with_summaries(per_run: int, summarizer: Model | None = None) -> Documents:
    from app.main import services

    return replace(
        services().documents,
        summaries=Summaries(
            graph=build_summary_graph(summarizer or local_summarizer()),
            model_name="test",
            monthly_tokens=MONTHLY,
            tokens_per_run=per_run,
        ),
    )


def summarize(client: TestClient, documents: Documents, org: UUID, user: UUID) -> None:
    [doc] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    on_app_loop(client, lambda: documents.summarize(org, doc.id, user))


def test_a_summary_over_the_run_limit_is_counted_and_not_retried(client: TestClient) -> None:
    org, user = with_a_document(client)
    # Returns normally: a job that raised would be retried, and spend again.
    summarize(client, documents_with_summaries(per_run=10), org, user)
    assert spent(org, "summary") > 0
    [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    assert listed.summary is None


def test_a_failed_summary_is_counted_and_retried(client: TestClient) -> None:
    # Two passages: each is summarized, then combining them fails.
    paragraph = "Refunds take five business days to arrive. " * 25
    org, user = with_a_document(client, f"{paragraph}\n\n{paragraph}")

    async def combining_fails(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if info.instructions == COMBINE:
            raise RuntimeError("the provider went away")
        return ModelResponse(parts=[TextPart("A passage about refunds.")])

    documents = documents_with_summaries(20_000, FunctionModel(combining_fails, model_name="test"))
    # Raises, so BullMQ tries again: a provider failure may pass.
    with pytest.raises(RuntimeError):
        summarize(client, documents, org, user)
    # The passage summaries it paid for, not nothing and not the reservation.
    assert 0 < spent(org, "summary") < 20_000
