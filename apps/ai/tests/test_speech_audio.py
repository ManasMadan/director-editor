"""Pure tests of how Director's voice reads Gemini's answer (app/speech.py): what the
integration tests' Gemini stand-in never answers with."""

import io
import wave

import pytest
from google.genai.types import Candidate, Content, GenerateContentResponse, Part

from app.speech import DEFAULT_SAMPLE_RATE, audio_of, usage_of, wav_of


def test_bare_samples_with_no_rate_are_at_gemini_s_own() -> None:
    with wave.Wave_read(io.BytesIO(wav_of("audio/pcm", b"\x00\x01" * 10))) as audio:
        assert audio.getframerate() == DEFAULT_SAMPLE_RATE
        assert audio.getnframes() == 10


def test_an_answer_with_no_usage_counts_nothing() -> None:
    assert usage_of(GenerateContentResponse()) == (0, 0)


def test_an_answer_with_no_content_has_no_audio() -> None:
    empty = GenerateContentResponse(candidates=[Candidate(), Candidate(content=Content())])
    with pytest.raises(ValueError, match="no audio"):
        _ = audio_of(empty)


def test_the_first_part_with_audio_is_the_line() -> None:
    answer = GenerateContentResponse(
        candidates=[
            Candidate(
                content=Content(
                    parts=[
                        Part(text="Here you go."),
                        Part.from_bytes(data=b"\x00\x00", mime_type="audio/L16;rate=16000"),
                    ]
                )
            )
        ]
    )
    with wave.Wave_read(io.BytesIO(audio_of(answer))) as audio:
        assert audio.getframerate() == 16_000
