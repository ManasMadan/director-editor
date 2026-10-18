"""Director's voice: a guide line read aloud by Gemini's text-to-speech (TTS_MODEL), as a
WAV file the shoot screen plays when the member isn't on a live call (on a call, Gemini
Live does the talking).

Pydantic AI has no audio output, so this calls the Gemini client underneath the same
model Director builds everything else with (`create_google_model`), which keeps one
place deciding how a model is addressed (Vertex's resource name, VERTEX_LOCATION).

Nothing is cached here: apps/api keeps each line it gets back in object storage, keyed by
the line and the voice, so the same line is only ever spoken once.
"""

import io
import re
import wave
from uuid import UUID

from google.genai.types import (
    GenerateContentConfig,
    GenerateContentResponse,
    HttpOptions,
    PrebuiltVoiceConfig,
    SpeechConfig,
    VoiceConfig,
)
from pydantic_ai.models.google import GoogleModel

from app.director import create_google_model
from app.errors import AppError
from app.log import log
from app.schemas import SpeechVoice
from app.settings import Settings
from app.usage import reserve, settle

# Someone is standing with their camera up, waiting to hear where to go; past this, the
# shoot screen has long since said it in the browser's own voice.
SPEECH_TIMEOUT_MS = 20_000
# What every Gemini TTS model speaks at, when its answer doesn't say.
DEFAULT_SAMPLE_RATE = 24_000
_WAV_TYPES = frozenset({"audio/wav", "audio/x-wav", "audio/wave"})
_PCM_TYPES = frozenset({"audio/l16", "audio/pcm"})
_RATE = re.compile(r"rate=(\d+)")


class _Unplayable(ValueError):
    """An answer with no audio a browser can play in it."""


def _config(voice: SpeechVoice) -> GenerateContentConfig:
    # No max_output_tokens: Vertex answers 400 to any value of it for gemini-3.8-flash-tts
    # (checked live), so the line's length limit is what bounds the output instead. No
    # system instruction either (400 too), and the line goes alone: gemini-3.8-flash-tts
    # reads a delivery note ("Say warmly: ...") aloud with it, so the voice (an upbeat one,
    # picked by the web app) is what sets the tone.
    return GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=SpeechConfig(
            voice_config=VoiceConfig(prebuilt_voice_config=PrebuiltVoiceConfig(voice_name=voice))
        ),
        http_options=HttpOptions(timeout=SPEECH_TIMEOUT_MS),
    )


def usage_of(response: GenerateContentResponse) -> tuple[int, int]:
    """The tokens an answer used: its prompt's and its audio's."""
    usage = response.usage_metadata
    if usage is None:
        return 0, 0
    return usage.prompt_token_count or 0, usage.candidates_token_count or 0


def wav_of(mime_type: str, data: bytes) -> bytes:
    """The audio as a WAV file: as it came when it already is one (gemini-3.8-flash-tts),
    or bare 16-bit little-endian mono samples (the 2.5 TTS models' `audio/L16`) given the
    header that makes them one."""
    kind, _, params = mime_type.partition(";")
    kind = kind.strip().lower()
    if kind in _WAV_TYPES:
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise _Unplayable("audio/wav that isn't a WAV file")
        return data
    if kind not in _PCM_TYPES:
        raise _Unplayable(f"audio as {kind}")
    rate = _RATE.search(params)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(int(rate.group(1)) if rate else DEFAULT_SAMPLE_RATE)
        audio.writeframes(data)
    return buffer.getvalue()


def audio_of(response: GenerateContentResponse) -> bytes:
    """The answer's audio, as a WAV file."""
    parts = [
        part
        for candidate in response.candidates or []
        if candidate.content
        for part in candidate.content.parts or []
    ]
    for part in parts:
        inline = part.inline_data
        if inline and inline.data and inline.mime_type:
            return wav_of(inline.mime_type, inline.data)
    raise _Unplayable("no audio in the answer")


class Speaker:
    def __init__(self, model: GoogleModel, model_name: str, *, monthly: int, per_line: int) -> None:
        # The short name for the usage ledger; `model.model_name` is the address sent to
        # Gemini, which on Vertex is the full resource name.
        self._model = model
        self._model_name = model_name
        self._monthly = monthly
        self._per_line = per_line

    async def speak(self, org_id: UUID, user_id: UUID, text: str, voice: SpeechVoice) -> bytes:
        """`text` said in `voice`, as a WAV file (AI_BUDGET_EXCEEDED, UPSTREAM_UNAVAILABLE
        when Gemini fails or answers without audio)."""
        reservation = await reserve(
            org_id,
            user_id,
            "director-speech",
            self._model_name,
            most=self._per_line,
            monthly=self._monthly,
        )
        if reservation is None:
            raise AppError("AI_BUDGET_EXCEEDED")
        used = (0, 0)
        try:
            # The output can't be capped at what's left (see _config), so a line waits
            # for a budget that holds a whole one; settling gives the reservation back.
            if reservation.tokens < self._per_line:
                raise AppError("AI_BUDGET_EXCEEDED")
            response = await self._generate(text, voice)
            used = usage_of(response)
            return audio_of(response)
        except _Unplayable as error:
            log.error("gemini's speech had no playable audio", reason=str(error))
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "gemini"}) from None
        finally:
            await settle(reservation, *used)

    async def _generate(self, text: str, voice: SpeechVoice) -> GenerateContentResponse:
        try:
            return await self._model.client.aio.models.generate_content(  # pyright: ignore[reportUnknownMemberType]  # its contents type names Pillow's Image, not installed
                model=self._model.model_name, contents=text, config=_config(voice)
            )
        except Exception:
            log.exception("speech failed", model=self._model_name)
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "gemini"}) from None


def create_speaker(settings: Settings) -> Speaker | None:
    """Director's voice; None while Director is off (DIRECTOR_MODEL unset)."""
    if not settings.director_model:
        return None
    return Speaker(
        create_google_model(settings, settings.tts_model),
        settings.tts_model,
        monthly=settings.monthly_tokens_per_org,
        per_line=settings.director_tokens_per_speech,
    )
