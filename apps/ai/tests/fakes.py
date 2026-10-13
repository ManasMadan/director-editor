"""Local stand-ins for third parties that speak their real HTTP protocol, so the code
under test talks to them exactly as it would to the real thing (the same idea as
packages/fake-stripe on the TypeScript side)."""

import json
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pydantic import BaseModel

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
            # OpenAI's SDK would otherwise retry a failure, which only slows a test down.
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


class EmbeddingsRequest(BaseModel):
    """What OpenAI's /v1/embeddings is sent."""

    model: str
    input: list[str]
    dimensions: int


def openai_embeddings(dimensions: int) -> Callable[[bytes], Reply]:
    """OpenAI's /v1/embeddings: one vector per input, of the dimensions asked for."""

    def reply(body: bytes) -> Reply:
        request = EmbeddingsRequest.model_validate_json(body)
        texts = request.input
        assert request.dimensions == dimensions
        return 200, {
            "object": "list",
            "model": request.model,
            "data": [
                {"object": "embedding", "index": i, "embedding": [1.0 / (i + 1)] * dimensions}
                for i in range(len(texts))
            ],
            "usage": {"prompt_tokens": len(texts), "total_tokens": len(texts)},
        }

    return reply


def openai_unavailable(_body: bytes) -> Reply:
    """A provider outage, as OpenAI reports one."""
    return 503, {"error": {"message": "overloaded", "type": "server_error", "code": None}}


def otlp_collector(_body: bytes) -> Reply:
    """An OpenTelemetry collector's OTLP/HTTP endpoint, accepting everything."""
    return 200, {}
