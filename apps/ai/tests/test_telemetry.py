"""Telemetry: off without an endpoint; with one, requests and database queries are traced
(health probes aren't) and log lines carry the trace. The tracer provider is global to
the process, so it starts once for this module."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import text

from app.db.session import close_engine, open_engine
from app.settings import get_settings
from app.telemetry import add_trace_ids, start_telemetry
from tests.support import ENV

app = FastAPI()
logged: dict[str, object] = {}


@app.get("/hello")
def hello() -> dict[str, str]:
    logged.update(add_trace_ids(None, "info", {"event": "hello"}))
    return {"ok": "yes"}


@app.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@pytest.fixture(scope="module")
def exporter() -> InMemorySpanExporter:
    spans = InMemorySpanExporter()
    assert start_telemetry("ai-test", app, processor=SimpleSpanProcessor(spans)) is True
    return spans


def test_nothing_starts_without_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert start_telemetry("ai", FastAPI()) is False


def test_requests_are_traced_and_logs_carry_the_trace(exporter: InMemorySpanExporter) -> None:
    client = TestClient(app)
    assert client.get("/hello").status_code == 200
    assert client.get("/health/live").status_code == 200

    spans = exporter.get_finished_spans()
    server = [span for span in spans if span.name == "GET /hello"]
    assert server, [span.name for span in spans]
    assert not [span for span in spans if "/health" in span.name]
    assert server[0].resource.attributes["service.name"] == "ai-test"
    context = server[0].get_span_context()
    assert context is not None
    assert logged["trace_id"] == format(context.trace_id, "032x")


@pytest.mark.integration
async def test_queries_of_engines_opened_later_are_traced(
    exporter: InMemorySpanExporter, monkeypatch: pytest.MonkeyPatch
) -> None:
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    engine = open_engine(get_settings().database_url, 1)
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    finally:
        await close_engine()
        get_settings.cache_clear()
    queries = [
        span
        for span in exporter.get_finished_spans()
        if span.attributes and span.attributes.get("db.system") == "postgresql"
    ]
    assert queries, [span.name for span in exporter.get_finished_spans()]
