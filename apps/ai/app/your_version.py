"""The member's version of a template, as a take is judged against it.

apps/api keeps the version (app.director_version, packages/contracts src/api/
your-version.ts): what Director remembers from the conversation ("Inside") and how each
shot changed for them ("at your desk"). A take filmed to their version must be reviewed
against it, never against the original's place or setup, so the review reads the version
when it runs: one place that covers every take, whether apps/api added it from the
shutter or apps/worker cut it from a roll. The service reads that table only (a column
grant, under row-level security), and the JSON is parsed here as the contract's
`YourVersion`.

`apply_shot_version` mirrors the contract's `applyShotVersion`, which the shoot screen
and Director live use, so the review sees the shot exactly as the member was shown it.
"""

from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.log import log
from app.schemas import ScriptLine, Shot, ShotVersion, YourVersion


def apply_shot_version(shot: Shot, version: ShotVersion | None) -> Shot:
    """The shot as the member's version has it: their title, their place as the scene
    (without the original's landmark), what they do as the first step (or the pose, with
    no steps), their line across the whole shot, their framing and their camera."""
    if version is None:
        return shot
    first = shot.steps[0] if shot.steps else None
    action = version.action
    return shot.model_copy(
        update={
            "title": version.title or shot.title,
            "scene": version.where or shot.scene,
            # The original's landmark belongs to the original's place.
            "sceneLandmark": None if version.where else shot.sceneLandmark,
            "steps": (
                [first.model_copy(update={"instruction": action}), *shot.steps[1:]]
                if action and first
                else shot.steps
            ),
            "pose": (
                shot.pose.model_copy(update={"description": action})
                if action and not first
                else shot.pose
            ),
            "script": (
                [ScriptLine(startSeconds=0, endSeconds=shot.durationSeconds, text=version.line)]
                if version.line
                else shot.script
            ),
            "framing": (
                shot.framing.model_copy(update={"note": version.framing})
                if version.framing
                else shot.framing
            ),
            "camera": version.camera or shot.camera,
        }
    )


def shot_version(version: YourVersion | None, shot_index: int) -> ShotVersion | None:
    if version is None:
        return None
    return next((shot for shot in version.shots if shot.shot == shot_index), None)


def told(version: YourVersion | None) -> list[str]:
    """What the member has told Director, a line a note: "- place: Inside"."""
    return [f"- {note.kind}: {note.note}" for note in version.notes] if version else []


async def your_version(session: AsyncSession, user_id: UUID, video_id: str) -> YourVersion | None:
    """The member's version of the template, in the session's workspace; None when they
    have none, or when it can't be read as one (logged: the original is used instead, as
    a review against it beats no review)."""
    row = (
        await session.execute(
            text(
                "SELECT version FROM app.director_version"
                " WHERE user_id = :user AND video_id = :video"
            ),
            {"user": user_id, "video": video_id},
        )
    ).first()
    if row is None:
        return None
    try:
        # Not strict: it's stored JSON (a list for a tuple, and so on), not a request.
        return YourVersion.model_validate(row[0], strict=False)
    except ValidationError as error:
        log.warning("a member's version isn't a YourVersion", errors=error.error_count())
        return None
