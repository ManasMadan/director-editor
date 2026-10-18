"""Director's voice against real Postgres and Redis, with a local Gemini API speaking its
real protocol (tests/fakes.py): a guide line comes back as a WAV file in the voice asked
for, its tokens are counted like every model call's, and every way the call can fail is
an error the API understands."""

import io
import wave
from collections.abc import Callable, Iterator
from uuid import UUID

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from tests.fakes import (
    GEMINI_MODEL,
    TTS_MODEL,
    TTS_PATH,
    Fake,
    Reply,
    gemini_error,
    gemini_speech,
    gemini_text_instead_of_speech,
    serve,
)
from tests.support import as_org, error_of, headers, new_org

pytestmark = pytest.mark.integration

LINE = "Take a small step to your left."
# A quarter of a second of 24 kHz, 16-bit mono samples.
PCM = bytes(range(256)) * 47
VERTEX_TTS_PATH = (
    "/v1beta1/projects/test-project/locations/global/publishers/google/models/"
    f"{TTS_MODEL}:generateContent"
)

type Gemini = tuple[Fake, dict[str, Callable[[bytes], Reply]]]


@pytest.fixture
def gemini() -> Iterator[Gemini]:
    """The Gemini API; a test swaps what it answers with through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {
        TTS_PATH: gemini_speech(PCM),
        VERTEX_TTS_PATH: gemini_speech(PCM),
    }
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def vertex() -> bool:
    """Gemini through Vertex AI rather than the Gemini API; a test parametrizes it."""
    return False


@pytest.fixture
def extra_env(gemini: Gemini, vertex: bool) -> dict[str, str]:
    env = {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "TTS_MODEL": TTS_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }
    if vertex:
        env |= {"GOOGLE_VERTEX": "true", "GOOGLE_CLOUD_PROJECT": "test-project"}
    return env


def speak(
    client: TestClient, org: UUID, user: UUID, text: str = LINE, voice: str = "Puck"
) -> httpx.Response:
    return client.post(
        "/v1/director/speak", json={"text": text, "voice": voice}, headers=headers(org, user)
    )


def usage(org: UUID) -> tuple[int, set[str]]:
    """The tokens the workspace's speech used, and the models they were recorded under."""
    rows = as_org(
        org,
        "SELECT input_tokens + output_tokens, model FROM ai.usage"
        " WHERE feature = 'director-speech'",
    )
    total, models = 0, set[str]()
    for tokens, model in rows:
        assert isinstance(tokens, int)
        assert isinstance(model, str)
        total += tokens
        models.add(model)
    return total, models


def spend_the_month(org: UUID, leaving: int = 0) -> None:
    """Uses up the workspace's monthly allowance (AI_MONTHLY_TOKENS_PER_ORG in the tests),
    but for `leaving` tokens."""
    _ = as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', %s, 0)",
        (org, 2_000_000 - leaving),
    )


def test_a_line_is_spoken_as_a_wav_file_in_the_voice_asked_for(
    client: TestClient, gemini: Gemini
) -> None:
    org, user = new_org()
    response = speak(client, org, user, voice="Kore")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "audio/wav"
    with wave.Wave_read(io.BytesIO(response.content)) as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 24_000)
        assert audio.readframes(audio.getnframes()) == PCM
    [(path, sent)] = gemini[0].received
    assert path == TTS_PATH
    # The line alone: the TTS model would read any note on how to say it aloud too.
    assert f'"parts": [{{"text": "{LINE}"}}]'.encode() in sent
    assert b'"responseModalities": ["AUDIO"]' in sent
    # The SDK spells speechConfig's fields in snake case, which Gemini's JSON (proto3's)
    # takes as well as camel case.
    assert b'{"prebuilt_voice_config": {"voice_name": "Kore"}}' in sent
    # What the call used, in place of what it reserved, under the TTS model's name.
    assert usage(org) == (200, {TTS_MODEL})


def test_samples_at_another_rate_keep_it(client: TestClient, gemini: Gemini) -> None:
    gemini[1][TTS_PATH] = gemini_speech(PCM, mime_type="audio/L16;codec=pcm;rate=16000")
    org, user = new_org()
    response = speak(client, org, user)
    with wave.Wave_read(io.BytesIO(response.content)) as audio:
        assert audio.getframerate() == 16_000


def test_a_wav_file_from_gemini_is_passed_on_as_it_is(client: TestClient, gemini: Gemini) -> None:
    """What gemini-3.8-flash-tts answers with: a whole WAV file, not bare samples."""
    whole = io.BytesIO()
    with wave.open(whole, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24_000)
        audio.writeframes(PCM)
    gemini[1][TTS_PATH] = gemini_speech(whole.getvalue(), mime_type="audio/wav")
    org, user = new_org()
    response = speak(client, org, user)
    assert response.status_code == 200, response.text
    assert response.content == whole.getvalue()


@pytest.mark.parametrize("vertex", [True])
def test_on_vertex_the_model_is_addressed_by_its_resource_name(
    client: TestClient, gemini: Gemini
) -> None:
    org, user = new_org()
    assert speak(client, org, user).status_code == 200
    assert [path for path, _ in gemini[0].received] == [VERTEX_TTS_PATH]
    # The ledger keeps the short name, never the resource path.
    assert usage(org)[1] == {TTS_MODEL}


@pytest.mark.parametrize(
    "answer",
    [
        gemini_error(503, "UNAVAILABLE"),
        gemini_error(400, "INVALID_ARGUMENT"),
        gemini_text_instead_of_speech,
        gemini_speech(b"ID3", mime_type="audio/mpeg"),
        gemini_speech(b"not a wav file", mime_type="audio/wav"),
    ],
    ids=["outage", "refusal", "words", "mp3", "broken-wav"],
)
def test_speech_gemini_can_t_give_is_an_upstream_failure(
    client: TestClient, gemini: Gemini, answer: Callable[[bytes], Reply]
) -> None:
    gemini[1][TTS_PATH] = answer
    org, user = new_org()
    response = speak(client, org, user)
    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")
    assert error_of(response).data.params == {"service": "gemini"}


def test_a_failed_call_still_counts_what_it_used(client: TestClient, gemini: Gemini) -> None:
    gemini[1][TTS_PATH] = gemini_text_instead_of_speech
    org, user = new_org()
    _ = speak(client, org, user)
    assert usage(org)[0] == 50


def test_with_no_budget_left_nothing_is_said(client: TestClient, gemini: Gemini) -> None:
    org, user = new_org()
    spend_the_month(org)
    response = speak(client, org, user)
    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")
    assert gemini[0].received == []


def test_less_than_a_whole_line_s_budget_left_is_none(client: TestClient, gemini: Gemini) -> None:
    """Vertex refuses a cap on a TTS model's output (max_output_tokens), so a line can't be
    cut off at what's left: it waits for a budget that holds a whole one."""
    org, user = new_org()
    spend_the_month(org, leaving=100)
    response = speak(client, org, user)
    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")
    assert gemini[0].received == []
    # The reservation is given back in full.
    assert usage(org)[0] == 0


@pytest.mark.parametrize(
    ("text", "voice"),
    [("", "Puck"), ("x" * 501, "Puck"), (LINE, "Robot"), (LINE, "puck")],
    ids=["empty", "too-long", "unknown-voice", "voice-in-lowercase"],
)
def test_only_a_bounded_line_in_a_known_voice_is_spoken(
    client: TestClient, gemini: Gemini, text: str, voice: str
) -> None:
    org, user = new_org()
    response = speak(client, org, user, text=text, voice=voice)
    assert (response.status_code, error_of(response).code) == (422, "VALIDATION_FAILED")
    assert gemini[0].received == []


@pytest.mark.parametrize("extra_env", [{}])
def test_speech_is_off_while_director_is(client: TestClient) -> None:
    org, user = new_org()
    response = speak(client, org, user)
    assert (response.status_code, error_of(response).code) == (404, "FEATURE_DISABLED")
    assert error_of(response).data.params == {"feature": "director"}
