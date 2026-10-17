"""Local stand-ins for third parties that speak their real HTTP protocol, so the code
under test talks to them exactly as it would to the real thing (the same idea as
packages/fake-google on the TypeScript side)."""

import json
import threading
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from google.api_core.client_options import ClientOptions
from google.auth.credentials import AnonymousCredentials
from google.cloud.bigquery import Client as BigQueryClient
from pydantic import BaseModel, Field

type Reply = tuple[int, dict[str, object]]


@dataclass
class Fake:
    """A server answering each POSTed path with its handler; `received` is what it got."""

    url: str
    received: list[tuple[str, bytes]] = field(default_factory=list[tuple[str, bytes]])


@contextmanager
def serve(handlers: dict[str, Callable[[bytes], Reply]]) -> Generator[Fake]:
    fake = Fake(url="")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            fake.received.append((self.path, body))
            handler = handlers.get(self.path)
            status, reply = handler(body) if handler else (404, {"error": "not found"})
            payload = json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            # A provider SDK would otherwise retry a failure, which only slows a test down.
            self.send_header("x-should-retry", "false")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()


GEMINI_MODEL = "gemini-test"
GEMINI_PATH = f"/v1beta/models/{GEMINI_MODEL}:generateContent"


def otlp_collector(_body: bytes) -> Reply:
    """An OpenTelemetry collector's OTLP/HTTP endpoint, accepting everything."""
    return 200, {}


def gemini_output(args: Mapping[str, object], *, tokens: int = 1_000) -> Callable[[bytes], Reply]:
    """The Gemini API's generateContent answering with Pydantic AI's output tool
    (`final_result`) called with `args`, having used `tokens` tokens."""

    def reply(_body: bytes) -> Reply:
        return 200, {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"functionCall": {"name": "final_result", "args": args}}],
                    },
                    "finishReason": "STOP",
                    "index": 0,
                }
            ],
            "usageMetadata": {
                "promptTokenCount": tokens - 100,
                "candidatesTokenCount": 100,
                "totalTokenCount": tokens,
            },
            "modelVersion": GEMINI_MODEL,
            "responseId": "fake-response",
        }

    return reply


def gemini_error(status: int, reason: str, message: str = "") -> Callable[[bytes], Reply]:
    """A refusal or outage, as the Gemini API reports one (403 PERMISSION_DENIED for a
    video it may not watch, 500 INTERNAL, ...)."""

    def reply(_body: bytes) -> Reply:
        return status, {"error": {"code": status, "message": message or reason, "status": reason}}

    return reply


BIGQUERY_PROJECT = "test-project"
BIGQUERY_DATASET = "director"
# tabledata.insertAll on the events table, as google-cloud-bigquery's client asks for it.
INSERT_ALL = (
    f"/bigquery/v2/projects/{BIGQUERY_PROJECT}/datasets/{BIGQUERY_DATASET}"
    "/tables/events/insertAll?prettyPrint=false"
)


def bigquery_inserted(_body: bytes) -> Reply:
    """insertAll accepting every row."""
    return 200, {"kind": "bigquery#tableDataInsertAllResponse"}


def bigquery_client(fake: Fake) -> Callable[[str], BigQueryClient]:
    """What app/analytics.py builds its client with, pointed at `fake`: anonymous, so it
    never looks for Application Default Credentials (nor the GCE metadata server)."""

    def build(project: str) -> BigQueryClient:
        return BigQueryClient(
            project=project,
            credentials=AnonymousCredentials(),
            client_options=ClientOptions(api_endpoint=fake.url),
        )

    return build


class _InsertedRow(BaseModel):
    values: dict[str, object] = Field(alias="json")


class _InsertAll(BaseModel):
    rows: list[_InsertedRow]


def inserted_rows(fake: Fake) -> list[dict[str, object]]:
    """Every row the stand-in BigQuery was asked to insert, in order."""
    return [
        row.values
        for path, body in fake.received
        if path == INSERT_ALL
        for row in _InsertAll.model_validate_json(body).rows
    ]


@contextmanager
def serve_files(files: dict[str, tuple[str, bytes]]) -> Generator[Fake]:
    """Object storage answering presigned GETs: each path's content type and bytes."""
    fake = Fake(url="")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            fake.received.append((self.path, b""))
            found = files.get(self.path.split("?")[0])
            if found is None:
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            content_type, data = found
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()
