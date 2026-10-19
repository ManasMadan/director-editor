"""The editor's calls to Director through the service's routes, with Gemini answering
from the local Gemini API (tests/fakes.py): a request to change the edit, typed or said,
and lining up a match cut between two takes (whose footage is read with ffmpeg)."""

import base64
from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.schemas import EditorReply, MatchCutAlignment
from tests.fakes import (
    GEMINI_MODEL,
    GEMINI_PATH,
    Fake,
    Reply,
    gemini_error,
    gemini_output,
    serve,
    serve_files,
)
from tests.match_cut_videos import Placement, output_box, write_clip
from tests.support import error_of, headers, new_org
from tests.test_director import PLAN, VIDEO, add_take, ready_plan, spend_the_month, usage

pytestmark = pytest.mark.integration

type Gemini = tuple[Fake, dict[str, Callable[[bytes], Reply]]]


@pytest.fixture
def gemini() -> Iterator[Gemini]:
    handlers: dict[str, Callable[[bytes], Reply]] = {GEMINI_PATH: gemini_output(PLAN)}
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(gemini: Gemini) -> dict[str, str]:
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }


# ------------------------------------------------------------------------------ the editor


def _state(take_id: UUID) -> dict[str, object]:
    """The edit as the browser holds it: the plan's two shots, the first with a take."""
    shot = {"startSeconds": 0, "endSeconds": 3, "grade": "none"}
    return {
        "shots": [
            {**shot, "shotIndex": 0, "takeId": str(take_id), "position": 0},
            {**shot, "shotIndex": 1, "takeId": None, "position": 1},
        ],
        "captions": "pop",
        "sound": True,
        "music": False,
        "fixes": [],
    }


def _ask(
    client: TestClient, org: UUID, user: UUID, take_id: UUID, **said: object
) -> httpx2.Response:
    body = {"videoId": VIDEO, "text": None, "audio": None, "audioType": None, **said}
    return client.post(
        "/v1/director/editor-requests",
        json={**body, "state": _state(take_id)},
        headers=headers(org, user),
    )


# Gemini's answer: shot 1's first take, by the numbers the member sees.
PICKED: dict[str, object] = {
    "heard": "use my first take for the opening",
    "outcome": "applied",
    "say": "Done: your first take opens it now.",
    "actions": [
        {
            "op": "pick_take",
            "shot": 1,
            "take": 1,
            **dict.fromkeys(
                ["otherShot", "position", "startSeconds", "endSeconds", "value", "level"]
            ),
            **dict.fromkeys(["text", "replacement", "steps"]),
        }
    ],
    "choices": [],
}
# About a second of speech, as the browser records it: any bytes will do for the fake.
SPOKEN = base64.b64encode(b"\x1a\x45\xdf\xa3" + b"\x00" * 200).decode()


def _editing(client: TestClient, gemini: Gemini) -> tuple[UUID, UUID, UUID]:
    """A workspace with a ready plan and one take of its first shot; Gemini answers
    the editor with PICKED."""
    org, user = new_org()
    _ = ready_plan(client, org, user)
    take = add_take(client, org, user, "http://storage/1")
    gemini[1][GEMINI_PATH] = gemini_output(PICKED, tokens=900)
    return org, user, take.id


def test_a_typed_request_comes_back_as_edits_on_real_shots_and_takes(
    client: TestClient, gemini: Gemini
) -> None:
    org, user, take_id = _editing(client, gemini)

    response = _ask(client, org, user, take_id, text="use my first take for the opening")

    assert response.status_code == 200, response.text
    reply = EditorReply.model_validate_json(response.content)
    assert (reply.outcome, reply.say) == ("applied", "Done: your first take opens it now.")
    [action] = reply.actions
    assert (action.op, action.shotIndex, action.takeId) == ("pick_take", 0, take_id)
    asked = gemini[0].received[-1][1]
    assert b"They typed: use my first take for the opening" in asked
    assert usage(org, "director-editor") == 900


def test_a_spoken_request_sends_gemini_the_recording(client: TestClient, gemini: Gemini) -> None:
    org, user, take_id = _editing(client, gemini)

    response = _ask(client, org, user, take_id, audio=SPOKEN, audioType="audio/webm")

    assert response.status_code == 200, response.text
    asked = gemini[0].received[-1][1]
    assert b"They said:" in asked
    assert b"audio/webm" in asked


@pytest.mark.parametrize(
    "said",
    [
        # Neither words nor a recording.
        {},
        # A recording with no type to read it as.
        {"audio": SPOKEN},
        # Not base64 at all.
        {"audio": "!" * 120, "audioType": "audio/webm"},
    ],
)
def test_a_request_with_nothing_to_hear_is_refused(
    client: TestClient, gemini: Gemini, said: dict[str, object]
) -> None:
    org, user, take_id = _editing(client, gemini)
    asked = len(gemini[0].received)

    response = _ask(client, org, user, take_id, **said)

    assert (response.status_code, error_of(response).code) == (422, "VALIDATION_FAILED")
    assert len(gemini[0].received) == asked


def test_a_request_without_budget_left_is_refused(client: TestClient, gemini: Gemini) -> None:
    org, user, take_id = _editing(client, gemini)
    spend_the_month(org)

    response = _ask(client, org, user, take_id, text="captions off")

    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")


def test_gemini_failing_is_upstream_unavailable(client: TestClient, gemini: Gemini) -> None:
    org, user, take_id = _editing(client, gemini)
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")

    response = _ask(client, org, user, take_id, text="captions off")

    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")
    assert usage(org, "director-editor") == 0


# ------------------------------------------------------------------------------ match cuts

STILL = Placement(270, 480)
# The last frame of the outgoing clip: 1.5 seconds at 30 a second.
LAST = 44


@pytest.fixture
def takes(tmp_path: Path) -> Iterator[Fake]:
    """Two takes of a wrist held still, served as presigned reads."""
    outgoing, incoming = tmp_path / "a.mp4", tmp_path / "b.mp4"
    write_clip(outgoing, 1, STILL, 1.5)
    write_clip(incoming, 2, STILL, 1.5)
    files = {
        "/a.mp4": ("video/mp4", outgoing.read_bytes()),
        "/b.mp4": ("video/mp4", incoming.read_bytes()),
    }
    with serve_files(files) as storage:
        yield storage


def _align(client: TestClient, org: UUID, user: UUID, storage: Fake) -> httpx2.Response:
    return client.post(
        "/v1/director/match-cuts",
        json={
            "anchor": "the watch on the left wrist",
            "outgoing": {"url": f"{storage.url}/a.mp4?sig=secret", "atMs": 1500},
            "incoming": {"url": f"{storage.url}/b.mp4?sig=secret", "atMs": 0},
        },
        headers=headers(org, user),
    )


def test_a_match_cut_is_lined_up_and_counted(
    client: TestClient, gemini: Gemini, takes: Fake
) -> None:
    org, user = new_org()
    # Gemini answers with the box as four numbers beside `visible` (AnchorSightingDraft).
    seen = {"visible": True, **output_box(STILL, LAST)}
    gemini[1][GEMINI_PATH] = gemini_output({"before": seen, "after": seen}, tokens=1_200)

    response = _align(client, org, user, takes)

    assert response.status_code == 200, response.text
    alignment = MatchCutAlignment.model_validate_json(response.content)
    assert (alignment.status, alignment.outgoingEndMs, alignment.incomingStartMs) == (
        "aligned",
        1500,
        0,
    )
    assert usage(org, "director-align") == 1_200


def test_a_match_cut_without_budget_left_is_refused(
    client: TestClient, gemini: Gemini, takes: Fake
) -> None:
    org, user = new_org()
    spend_the_month(org)
    asked = len(gemini[0].received)

    response = _align(client, org, user, takes)

    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")
    assert len(gemini[0].received) == asked


def test_a_match_cut_gemini_can_t_see_is_upstream_unavailable(
    client: TestClient, gemini: Gemini, takes: Fake
) -> None:
    org, user = new_org()
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")

    response = _align(client, org, user, takes)

    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")
    assert usage(org, "director-align") == 0
