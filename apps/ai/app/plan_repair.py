"""Make an unusable shot plan usable instead of failing the analysis.

Gemini's plan passes `ShotPlanDraft` validation field by field (every number is in its
own range), but nothing ties a script line or a step to its shot's actual edited
duration, one shot's source range to the one before it, or all of a plan's shots' edited
durations to how long the short they're being cut into can actually be. A plan with one
such mistake would otherwise fail the whole analysis (DIRECTOR_ANALYSIS_FAILED) over a
detail nobody filming would notice is wrong. `repair_plan` cleans those up
deterministically, so a small inconsistency costs a repair, not the plan.

A list's own length (how many shots, steps, script lines or pose keypoints) is one such
detail, and a special case: the draft Gemini answers with carries no length bound on
`shots`, `steps`, `script` or `pose.keypoints` (app/schemas.py's module comment says
why), so `repair_plan` is also where `MAX_SHOTS`, `MAX_SHOT_STEPS`, `MAX_SCRIPT_LINES`
and `MAX_POSE_KEYPOINTS` are enforced, by trimming an answer that runs over. The result
is validated against the real `ShotPlan` (which does carry those bounds, among everything
else): a trim that still runs over fails loudly here, rather than being stored.

The plan's assets and edits get the same treatment: an asset's id becomes one its
default image's storage key can carry, timings are kept inside the Short and in order,
and each edit (one flat shape in the draft, so Gemini's schema stays simple) becomes its
own type's model, or is dropped when it lacks what its type needs (an overlay with
nothing to show, a grade with no grade).
"""

import math
import re
from collections.abc import Callable

from app.schemas import (
    COLOR_PATTERN,
    MAX_ASSET_ID,
    MAX_ASSET_TEXT_LINES,
    MAX_ASSETS,
    MAX_EDITS,
    MAX_POSE_KEYPOINTS,
    MAX_SCRIPT_LINES,
    MAX_SHORT_SECONDS,
    MAX_SHOT_SECONDS,
    MAX_SHOT_STEPS,
    MAX_SHOTS,
    AssetDraft,
    EditDraft,
    EditType,
    ScriptLine,
    ShotDraft,
    ShotPlan,
    ShotPlanDraft,
    ShotStep,
)

# Below this, a shot's source range is leftover noise (a cut mistimed by a fraction of a
# second), not a shot anyone could film.
MIN_SHOT_SOURCE_SECONDS = 0.3
# ScriptLine.endSeconds must be at least this (its own Field constraint); a clamped line
# shorter than it said nothing worth keeping.
MIN_SCRIPT_LINE_SECONDS = 0.1


def repair_plan(plan: ShotPlanDraft, video_seconds: float | None) -> ShotPlan:
    """`plan`, with every shot's timing made consistent with itself, its neighbours and
    the short itself, and every list back within the limit Gemini's own schema no longer
    states.

    Shots are sorted by where they start in the source and trimmed so they never
    overlap; their source range is clamped into the video's own length (or, when that
    isn't known yet, `MAX_SHORT_SECONDS`); a shot left shorter than
    `MIN_SHOT_SOURCE_SECONDS` is dropped, unless that would empty the plan, in which case
    the longest of them survives anyway. What's left is trimmed to `MAX_SHOTS`, keeping
    the earliest ones and the last (the payoff the plan was building to, never the one a
    plain cut from the tail would drop). Each remaining shot's edited duration is clamped
    to a sane range; if those durations would add up to more than the short can hold
    (the same ceiling the source ranges use), every one of them is scaled down together,
    proportionally, to fit it exactly, never below the 0.5s floor. Only then are a shot's
    script lines and steps pulled back inside it (so they land inside the scaled
    duration, not the one Gemini wrote) and trimmed to `MAX_SCRIPT_LINES` and
    `MAX_SHOT_STEPS`, a shot left with no steps gets one synthesized from its scene, and
    its pose's keypoints are trimmed to `MAX_POSE_KEYPOINTS`. The plan's own
    `durationSeconds` is then the sum of its shots', not whatever Gemini originally wrote.
    Last, its assets and edits are repaired against where the Short ends
    (`_repair_assets`, `_repair_edits`).

    Raises `ValueError` for a plan with no shots at all: there's nothing to repair that
    into, and the draft's `shots` carries no `minItems` to have refused it on the way in.
    """
    if not plan.shots:
        raise ValueError("a shot plan needs at least one shot")
    ceiling = video_seconds if video_seconds is not None else MAX_SHORT_SECONDS
    shots = sorted(plan.shots, key=lambda shot: shot.sourceStartSeconds)
    shots = [_clamp_source(shot, ceiling) for shot in shots]
    shots = _remove_overlaps(shots)
    shots = _trim_shots(_drop_slivers(shots))
    durations = _scaled_durations(shots, ceiling)
    repaired = [
        _repair_shot(shot, duration) for shot, duration in zip(shots, durations, strict=True)
    ]
    end = _end_of_short(repaired, video_seconds)
    assets, renamed = _repair_assets(plan.assets, end)
    # Validated against the real ShotPlan (its Field constraints, not the draft's looser
    # ones): a trim that still leaves too much of something raises here, loudly, rather
    # than writing an inconsistent plan.
    return ShotPlan.model_validate(
        {
            **plan.model_dump(mode="json"),
            "shots": [shot.model_dump(mode="json") for shot in repaired],
            "durationSeconds": sum(shot.durationSeconds for shot in repaired),
            "assets": assets,
            "edits": _repair_edits(plan.edits, renamed, end),
        }
    )


def _clamp_source(shot: ShotDraft, ceiling: float) -> ShotDraft:
    return shot.model_copy(
        update={
            "sourceStartSeconds": _clamp(shot.sourceStartSeconds, 0, ceiling),
            "sourceEndSeconds": _clamp(shot.sourceEndSeconds, 0, ceiling),
        }
    )


def _remove_overlaps(shots: list[ShotDraft]) -> list[ShotDraft]:
    """Each shot's source range trimmed so it ends no later than the next one starts
    (the shots are already sorted by where they start)."""
    fixed: list[ShotDraft] = []
    for index, shot in enumerate(shots):
        end = shot.sourceEndSeconds
        if index + 1 < len(shots):
            end = min(end, shots[index + 1].sourceStartSeconds)
        fixed.append(shot.model_copy(update={"sourceEndSeconds": end}))
    return fixed


def _drop_slivers(shots: list[ShotDraft]) -> list[ShotDraft]:
    kept = [shot for shot in shots if _source_span(shot) >= MIN_SHOT_SOURCE_SECONDS]
    if kept:
        return kept
    # Every shot was a sliver (true before any overlap was even removed): the plan still
    # needs one, so the longest of them stands in rather than leaving none at all.
    return [max(shots, key=_source_span)]


def _trim_shots(shots: list[ShotDraft]) -> list[ShotDraft]:
    """At most `MAX_SHOTS`: the earliest ones, plus the last. Cutting the tail would
    always drop the payoff, the shot the whole plan was building to."""
    if len(shots) <= MAX_SHOTS:
        return shots
    return [*shots[: MAX_SHOTS - 1], shots[-1]]


def _source_span(shot: ShotDraft) -> float:
    return shot.sourceEndSeconds - shot.sourceStartSeconds


# A duration scaled below this would read as barely there; the floor binds before
# anything scales under it.
MIN_SHOT_DURATION_SECONDS = 0.5


def _scaled_durations(shots: list[ShotDraft], ceiling: float) -> list[float]:
    """Each shot's edited duration, clamped to `[0.5, MAX_SHOT_SECONDS]` on its own, then
    fit to `ceiling` if they'd add up to more: the edited durations of a short's shots
    have to fit the short, the same way its shots' sources have to fit the video they're
    cut from."""
    clamped = [
        _clamp(shot.durationSeconds, MIN_SHOT_DURATION_SECONDS, MAX_SHOT_SECONDS) for shot in shots
    ]
    if sum(clamped) <= ceiling:
        return clamped
    return _fit_to_ceiling(clamped, ceiling)


def _fit_to_ceiling(durations: list[float], ceiling: float) -> list[float]:
    """`durations` (already over `ceiling`), scaled down together to add up to it, never
    below `MIN_SHOT_DURATION_SECONDS`, and keeping every one's share of the whole (a
    duration twice as long as another stays twice as long).

    A single scale applied to every duration at once, with the floor then clamped in per
    duration, isn't enough: whichever durations the scale alone would take under the
    floor get floored *more* than their fair share, and with several of them that excess
    can push the total well past `ceiling` (not a rounding error: fuzzed, one draw of 12
    random durations overshot by 0.11s). So durations the current scale would take under
    the floor are pinned there instead, one round at a time, and the rest split what's
    left of `ceiling` among themselves at a new scale -- since pinning one changes every
    other's fair share, this can take more than one round. It always finishes: each round
    either pins at least one more duration or stops, and there are only so many to pin.

    Floored to whole milliseconds at the very end: floating-point multiplication can
    still leave the exact total a few ulps over `ceiling`, which `ShotPlan.
    durationSeconds`'s own `le=MAX_SHORT_SECONDS` would then refuse. A millisecond is far
    coarser than that error ever is, so flooring to it (never rounding, which could round
    up) keeps every duration at or under its exact share, and the total at or under
    `ceiling` -- unless every duration is already pinned at the floor and that alone
    exceeds `ceiling`, which needs more shots at the floor than `MAX_SHOTS` allows.
    """
    pinned = [False] * len(durations)
    result = list(durations)
    while True:
        free = [index for index, is_pinned in enumerate(pinned) if not is_pinned]
        if not free:
            break
        room = ceiling - sum(result[index] for index in range(len(result)) if pinned[index])
        free_total = sum(durations[index] for index in free)
        if room <= 0 or free_total <= 0:
            for index in free:
                result[index] = MIN_SHOT_DURATION_SECONDS
            break
        scale = room / free_total
        overflowing = [
            index for index in free if durations[index] * scale < MIN_SHOT_DURATION_SECONDS
        ]
        if not overflowing:
            for index in free:
                result[index] = durations[index] * scale
            break
        for index in overflowing:
            result[index] = MIN_SHOT_DURATION_SECONDS
            pinned[index] = True
    return [math.floor(duration * 1000) / 1000 for duration in result]


def _repair_shot(shot: ShotDraft, duration: float) -> ShotDraft:
    steps = [_repair_step(step, duration) for step in shot.steps][:MAX_SHOT_STEPS]
    return shot.model_copy(
        update={
            "durationSeconds": duration,
            "script": _repair_script(shot.script, duration),
            "steps": steps or [_synthesized_step(shot)],
            "pose": shot.pose.model_copy(
                update={"keypoints": shot.pose.keypoints[:MAX_POSE_KEYPOINTS]}
            ),
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
    return repaired[:MAX_SCRIPT_LINES]


def _repair_step(step: ShotStep, duration: float) -> ShotStep:
    return step.model_copy(update={"atSeconds": _clamp(step.atSeconds, 0, duration)})


def _synthesized_step(shot: ShotDraft) -> ShotStep:
    """A shot Gemini left with no steps at all gets one, from its scene (already in the
    short's own language, unlike a hard-coded phrase), rather than fail the plan over a
    detail a beginner filmer would never notice was synthesized."""
    return ShotStep(atSeconds=0, instruction=shot.scene[:160], cameraMove="static")


# ---------------------------------------------------------------------- assets and edits

# Below this, an edit is a blink nobody would see, except a transition, which gets the
# length of a quick one when Gemini gives it none (a cut is an instant).
MIN_EDIT_SECONDS = 0.1
TRANSITION_SECONDS = 0.3
_COLOR = re.compile(COLOR_PATTERN)
_WORD = re.compile(r"[a-z0-9]+")
# What a repaired asset or edit is before ShotPlan validates it.
type Fields = dict[str, object]
# The asset an edit names, by the id Gemini gave it: its repaired id, or None when the
# plan has no such asset.
type AssetOf = Callable[[str | None], str | None]


def _end_of_short(shots: list[ShotDraft], video_seconds: float | None) -> float:
    """Where the Short ends, for an asset's or an edit's timing (seconds of the original,
    like a shot's source range): the video's own length when it's known, otherwise where
    its last shot ends."""
    end = video_seconds if video_seconds is not None else max(s.sourceEndSeconds for s in shots)
    return max(end, MIN_EDIT_SECONDS)


def _text(value: str | None) -> str | None:
    """`value` without the spaces around it; None when that leaves nothing."""
    stripped = (value or "").strip()
    return stripped or None


def _color(value: str | None) -> str | None:
    return value if value is not None and _COLOR.fullmatch(value) else None


def _repair_assets(drafts: list[AssetDraft], end: float) -> tuple[list[Fields], dict[str, str]]:
    """The assets in the order they first show, at most `MAX_ASSETS`, each with an id the
    storage key can carry (unique in the plan), its timing inside the Short and its text
    trimmed; and each kept one's new id by the id Gemini gave it, for the edits."""
    kept = sorted(drafts, key=lambda draft: draft.sourceStartSeconds)[:MAX_ASSETS]
    used: set[str] = set()
    renamed: dict[str, str] = {}
    assets: list[Fields] = []
    for position, draft in enumerate(kept, start=1):
        asset_id = _unique(_slug(draft.id) or f"asset-{position}", position, used)
        used.add(asset_id)
        renamed.setdefault(draft.id, asset_id)
        start, stop = _span(draft.sourceStartSeconds, draft.sourceEndSeconds, end)
        lines = [line.strip()[:200] for line in draft.reference.text if line.strip()]
        reference = {
            **draft.reference.model_dump(mode="json"),
            "text": lines[:MAX_ASSET_TEXT_LINES],
        }
        assets.append(
            {
                **draft.model_dump(mode="json"),
                "id": asset_id,
                "reference": reference,
                "sourceStartSeconds": start,
                "sourceEndSeconds": stop,
                "ask": _text(draft.ask),
            }
        )
    return assets, renamed


def _slug(text: str) -> str:
    """`text` as lowercase words joined by hyphens: never longer than it was."""
    return "-".join(_WORD.findall(text.lower()))


def _unique(asset_id: str, position: int, used: set[str]) -> str:
    """`asset_id`, or one with a number after it when another asset has it already."""
    candidate, number = asset_id, position
    while candidate in used:
        suffix = f"-{number}"
        candidate = asset_id[: MAX_ASSET_ID - len(suffix)].rstrip("-") + suffix
        number += 1
    return candidate


def _span(start: float, stop: float, end: float) -> tuple[float, float]:
    """An asset's timing inside the Short; the whole Short when what's left isn't one."""
    start, stop = _clamp(start, 0, end), _clamp(stop, 0, end)
    return (start, stop) if stop - start >= MIN_EDIT_SECONDS else (0, end)


def _repair_edits(drafts: list[EditDraft], renamed: dict[str, str], end: float) -> list[Fields]:
    """Each edit as its type's own model, inside the Short and in order of when it
    starts (ties as they came), at most `MAX_EDITS`; one its type can't be made whole
    from is dropped. An asset it names is the repaired one (`renamed`), or none."""

    def asset_of(asset_id: str | None) -> str | None:
        return renamed.get(asset_id) if asset_id is not None else None

    edits: list[tuple[float, float, Fields]] = []
    for draft in drafts:
        timing = _edit_timing(draft, end)
        fields = _EDITS[draft.type](draft, asset_of)
        if timing is not None and fields is not None:
            start, stop = timing
            edit = {"type": draft.type, "startSeconds": start, "endSeconds": stop, **fields}
            edits.append((start, stop, edit))
    edits.sort(key=lambda each: each[:2])
    return [edit for _, _, edit in edits[:MAX_EDITS]]


def _edit_timing(draft: EditDraft, end: float) -> tuple[float, float] | None:
    start, stop = _clamp(draft.startSeconds, 0, end), _clamp(draft.endSeconds, 0, end)
    if stop - start >= MIN_EDIT_SECONDS:
        return start, stop
    if draft.type != "transition":
        return None
    start = max(0, min(start, end - TRANSITION_SECONDS))
    return start, min(start + TRANSITION_SECONDS, end)


def _layout(draft: EditDraft, asset_of: AssetOf) -> Fields | None:
    if draft.layout is None or (draft.layout == "picture-in-picture" and draft.box is None):
        return None
    split = draft.layout == "split"
    inset = draft.layout == "picture-in-picture"
    share = _clamp(draft.cameraShare or 0.5, 0.2, 0.8)
    return {
        "layout": draft.layout,
        "assetId": asset_of(draft.assetId),
        "cameraOn": (draft.cameraOn or "top") if split else None,
        "cameraShare": share if split else None,
        "box": draft.box.model_dump() if inset and draft.box else None,
        "inset": (draft.inset or "camera") if inset else None,
    }


def _overlay(draft: EditDraft, asset_of: AssetOf) -> Fields | None:
    asset_id = asset_of(draft.assetId)
    if draft.box is None or (asset_id is None and draft.mark is None):
        return None
    return {
        "assetId": asset_id,
        "mark": draft.mark,
        "color": _color(draft.color),
        "box": draft.box.model_dump(),
        "entry": draft.entry or "cut",
        "exit": draft.exit or "cut",
    }


def _grade(draft: EditDraft, _asset_of: AssetOf) -> Fields | None:
    if draft.grade is None:
        return None
    return {"grade": draft.grade, "target": draft.target or "all"}


def _words(draft: EditDraft, _asset_of: AssetOf) -> Fields | None:
    captions = draft.style == "captions"
    text = None if captions else _text(draft.text)
    if draft.style is None or (not captions and text is None):
        return None
    return {
        "style": draft.style,
        "text": text,
        "position": draft.position or "bottom",
        "captionStyle": (draft.captionStyle or "word-by-word") if captions else None,
        "color": _color(draft.color),
        "highlightColor": _color(draft.highlightColor),
    }


def _transition(draft: EditDraft, _asset_of: AssetOf) -> Fields | None:
    if draft.transition is None:
        return None
    return {"transition": draft.transition, "anchor": _text(draft.anchor)}


def _speed(draft: EditDraft, _asset_of: AssetOf) -> Fields | None:
    start = _clamp(draft.fromRate or 1, 0.1, 8)
    stop = _clamp(draft.toRate or start, 0.1, 8)
    if start == stop == 1:
        return None
    return {"fromRate": start, "toRate": stop, "easing": draft.easing or "linear"}


def _end_card(draft: EditDraft, asset_of: AssetOf) -> Fields | None:
    return {
        "assetId": asset_of(draft.assetId),
        "text": _text(draft.text),
    }


def _gap(draft: EditDraft, _asset_of: AssetOf) -> Fields | None:
    description = _text(draft.description)
    return None if description is None else {"description": description}


# What each edit type keeps of the flat draft (None: it can't be made whole).
_EDITS: dict[EditType, Callable[[EditDraft, AssetOf], Fields | None]] = {
    "layout": _layout,
    "overlay": _overlay,
    "grade": _grade,
    "text": _words,
    "transition": _transition,
    "speed": _speed,
    "end-card": _end_card,
    "gap": _gap,
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(value, high))
