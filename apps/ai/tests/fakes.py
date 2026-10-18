"""Local stand-ins for third parties that speak their real HTTP protocol, so the code
under test talks to them exactly as it would to the real thing (the same idea as
packages/fake-google on the TypeScript side)."""

import base64
import json
import secrets
import threading
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
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
    # Each request's Authorization header (None when it had none), in the same order.
    authorizations: list[str | None] = field(default_factory=list[str | None])


@contextmanager
def serve(handlers: dict[str, Callable[[bytes], Reply]]) -> Generator[Fake]:
    fake = Fake(url="")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            fake.received.append((self.path, body))
            fake.authorizations.append(self.headers.get("authorization"))
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


TTS_MODEL = "gemini-test-tts"
TTS_PATH = f"/v1beta/models/{TTS_MODEL}:generateContent"
# What the Gemini 2.5 TTS models answer with: raw 16-bit little-endian mono samples.
# gemini-3.8-flash-tts answers with a whole WAV file instead ("audio/wav"), checked live
# on Vertex.
PCM_TYPE = "audio/L16;codec=pcm;rate=24000"


def gemini_speech(
    audio: bytes, *, mime_type: str = PCM_TYPE, tokens: int = 200
) -> Callable[[bytes], Reply]:
    """The Gemini API's generateContent answering a speech request (responseModalities
    AUDIO) with `audio` inline, as `mime_type`, having used `tokens` tokens (12 of them the
    prompt's, the rest the audio's)."""

    def reply(_body: bytes) -> Reply:
        part: dict[str, object] = {
            "inlineData": {"mimeType": mime_type, "data": base64.b64encode(audio).decode()}
        }
        return 200, _speech_answer([part], tokens)

    return reply


def gemini_text_instead_of_speech(_body: bytes) -> Reply:
    """A speech request answered with words rather than audio (a TTS model can, when it
    takes the line for a question to answer)."""
    return 200, _speech_answer([{"text": "Sure! Here you go."}], 50)


def _speech_answer(parts: list[dict[str, object]], tokens: int) -> dict[str, object]:
    return {
        "candidates": [
            {"content": {"role": "model", "parts": parts}, "finishReason": "STOP", "index": 0}
        ],
        "usageMetadata": {
            "promptTokenCount": 12,
            "candidatesTokenCount": tokens - 12,
            "totalTokenCount": tokens,
        },
        "modelVersion": TTS_MODEL,
        "responseId": "fake-speech",
    }


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


MEDIA_BUCKET = "director-media-test"
# A multipart upload, as google-cloud-storage sends one for a small file (with
# STORAGE_EMULATOR_HOST pointing it at the fake, under anonymous credentials).
GCS_UPLOAD = f"/upload/storage/v1/b/{MEDIA_BUCKET}/o?uploadType=multipart"


def gcs_uploaded(_body: bytes) -> Reply:
    """Cloud Storage's JSON API accepting an upload (the object resource it answers with)."""
    return 200, {"bucket": MEDIA_BUCKET, "name": "uploaded", "generation": "1"}


# ---------------------------------------------------------------------- Google identity
# The GCE metadata server (what Cloud Run and the VM hand ID and access tokens out from)
# and Google's certificate endpoint for verifying those ID tokens, served by one local
# server: the metadata server's paths need the `Metadata-Flavor: Google` header, as the
# real one's do, and the certificates are the public half of the key it signs with.

SERVICE_ACCOUNT = "director-vm@test-project.iam.gserviceaccount.com"
ACCESS_TOKEN = secrets.token_urlsafe(16)
CERTS_PATH = "/oauth2/v1/certs"
GOOGLE_ISSUER = "https://accounts.google.com"
_ACCOUNT = "/computeMetadata/v1/instance/service-accounts/default"


@dataclass
class Identity:
    """The running stand-in: `url` for the certificates, `host` (host:port) for
    GCE_METADATA_HOST, `requests` every path it was asked for."""

    url: str
    host: str
    service_account: str
    key: RSAPrivateKey
    key_id: str = "fake-key"
    requests: list[str] = field(default_factory=list[str])

    def token(self, audience: str, **claims: object) -> str:
        """An ID token as the metadata server signs one for `audience` (format=full),
        with any claim replaced or added."""
        now = int(time.time())
        payload: dict[str, object] = {
            "iss": GOOGLE_ISSUER,
            "aud": audience,
            "azp": "1234567890",
            "sub": "1234567890",
            "email": self.service_account,
            "email_verified": True,
            "iat": now,
            "exp": now + 3600,
        }
        return jwt.encode({**payload, **claims}, self.key, "RS256", {"kid": self.key_id})


type _Route = Callable[[str], tuple[str, bytes]]


def _metadata_routes(identity: Identity) -> dict[str, _Route]:
    """Each metadata path's content type and body, from its query string."""

    def text(value: str) -> tuple[str, bytes]:
        return "text/plain", value.encode()

    def data(value: object) -> tuple[str, bytes]:
        return "application/json", json.dumps(value).encode()

    return {
        # google-auth's check that it runs on Google Cloud: any answer with the header.
        "/": lambda _query: text("ok"),
        "/computeMetadata/v1/project/project-id": lambda _query: text("test-project"),
        f"{_ACCOUNT}/": lambda _query: data(
            {"email": identity.service_account, "aliases": ["default"], "scopes": []}
        ),
        f"{_ACCOUNT}/token": lambda _query: data(
            {"access_token": ACCESS_TOKEN, "expires_in": 3599, "token_type": "Bearer"}
        ),
        f"{_ACCOUNT}/identity": lambda query: text(identity.token(parse_qs(query)["audience"][0])),
    }


# A status, then the body's content type and bytes.
type _Answer = tuple[int, tuple[str, bytes]]


def _identity_reply(identity: Identity, path: str, query: str, flavor: str | None) -> _Answer:
    if path == CERTS_PATH:
        public = identity.key.public_key().public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
        )
        return 200, ("application/json", json.dumps({identity.key_id: public.decode()}).encode())
    route = _metadata_routes(identity).get(path)
    if route is None:
        return 404, ("text/plain", b"not found")
    if path != "/" and flavor != "Google":
        return 403, ("text/plain", b"missing Metadata-Flavor: Google")
    return 200, route(query)


@contextmanager
def serve_identity(service_account: str = SERVICE_ACCOUNT) -> Generator[Identity]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    identity = Identity(url="", host="", service_account=service_account, key=key)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            identity.requests.append(self.path)
            path, _, query = self.path.partition("?")
            status, (content_type, payload) = _identity_reply(
                identity, path, query, self.headers.get("metadata-flavor")
            )
            self.send_response(status)
            self.send_header("metadata-flavor", "Google")
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    identity.host = f"127.0.0.1:{server.server_address[1]}"
    identity.url = f"http://{identity.host}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield identity
    finally:
        server.shutdown()
