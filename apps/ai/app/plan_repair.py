"""Make an unusable shot plan usable instead of failing the analysis.

Gemini's plan passes `ShotPlan` validation field by field (every number is in its own
range), but nothing ties a script line or a step to its shot's actual edited duration, or
one shot's source range to the one before it. A plan with one such mistake would
otherwise fail the whole analysis (DIRECTOR_ANALYSIS_FAILED) over a detail nobody
filming would notice is wrong. `repair_plan` cleans those up deterministically, so a
small inconsistency costs a repair, not the plan.
"""

from app.schemas import MAX_SHORT_SECONDS, MAX_SHOT_SECONDS, ScriptLine, Shot, ShotPlan, ShotStep

# Below this, a shot's source range is leftover noise (a cut mistimed by a fraction of a
# second), not a shot anyone could film.
MIN_SHOT_SOURCE_SECONDS = 0.3
# ScriptLine.endSeconds must be at least this (its own Field constraint); a clamped line
# shorter than it said nothing worth keeping.
MIN_SCRIPT_LINE_SECONDS = 0.1


def repair_plan(plan: ShotPlan, video_seconds: float | None) -> ShotPlan:
    """`plan`, with every shot's timing made consistent with itself and its neighbours.

    Shots are sorted by where they start in the source and trimmed so they never
    overlap; their source range is clamped into the video's own length (or, when that
    isn't known yet, `MAX_SHORT_SECONDS`); a shot left shorter than
    `MIN_SHOT_SOURCE_SECONDS` is dropped, unless that would empty the plan, in which case
    the longest of them survives anyway (`ShotPlan.shots` needs at least one). Each
    remaining shot's edited duration is clamped to a sane range, and its script lines and
    steps are pulled back inside it. The plan's own `durationSeconds` is then the sum of
    its shots', not whatever Gemini originally wrote.
    """
    ceiling = video_seconds if video_seconds is not None else MAX_SHORT_SECONDS
    shots = sorted(plan.shots, key=lambda shot: shot.sourceStartSeconds)
    shots = [_clamp_source(shot, ceiling) for shot in shots]
    shots = _remove_overlaps(shots)
    shots = _drop_slivers(shots)
    shots = [_repair_shot(shot) for shot in shots]
    return plan.model_copy(
        update={
            "shots": shots,
            "durationSeconds": sum(shot.durationSeconds for shot in shots),
        }
    )


def _clamp_source(shot: Shot, ceiling: float) -> Shot:
    return shot.model_copy(
        update={
            "sourceStartSeconds": _clamp(shot.sourceStartSeconds, 0, ceiling),
            "sourceEndSeconds": _clamp(shot.sourceEndSeconds, 0, ceiling),
        }
    )


def _remove_overlaps(shots: list[Shot]) -> list[Shot]:
    """Each shot's source range trimmed so it ends no later than the next one starts
    (the shots are already sorted by where they start)."""
    fixed: list[Shot] = []
    for index, shot in enumerate(shots):
        end = shot.sourceEndSeconds
        if index + 1 < len(shots):
            end = min(end, shots[index + 1].sourceStartSeconds)
        fixed.append(shot.model_copy(update={"sourceEndSeconds": end}))
    return fixed


def _drop_slivers(shots: list[Shot]) -> list[Shot]:
    kept = [shot for shot in shots if _source_span(shot) >= MIN_SHOT_SOURCE_SECONDS]
    if kept:
        return kept
    # Every shot was a sliver (true before any overlap was even removed): the plan still
    # needs one, so the longest of them stands in rather than leaving none at all.
    return [max(shots, key=_source_span)]


def _source_span(shot: Shot) -> float:
    return shot.sourceEndSeconds - shot.sourceStartSeconds


def _repair_shot(shot: Shot) -> Shot:
    duration = _clamp(shot.durationSeconds, 0.5, MAX_SHOT_SECONDS)
    return shot.model_copy(
        update={
            "durationSeconds": duration,
            "script": _repair_script(shot.script, duration),
            "steps": [_repair_step(step, duration) for step in shot.steps],
        }
    )


def _repair_script(lines: list[ScriptLine], duration: float) -> list[ScriptLine]:
    repaired: list[ScriptLine] = []
    for line in lines:
        start = _clamp(line.startSeconds, 0, duration)
        end = _clamp(line.endSeconds, 0, duration)
        if end - start < MIN_SCRIPT_LINE_SECONDS:
            continue  # Clamping left nothing worth saying: drop it rather than keep a blink.
        repaired.append(line.model_copy(update={"startSeconds": start, "endSeconds": end}))
    return repaired


def _repair_step(step: ShotStep, duration: float) -> ShotStep:
    return step.model_copy(update={"atSeconds": _clamp(step.atSeconds, 0, duration)})


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(value, high))
