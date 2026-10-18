"""Storyboard cards: one pencil sketch per shot, drawn by Nano Banana from the shot's own
directions (where, the framing, who or what is in it, the feeling it's going for), never
from titles, steps or script lines, which can name a brand. The seeds' cards are made
once by scripts/seed_media.py; a created plan's are drawn in the worker like its assets'
images (app/assets.py), each stored as an image of origin `storyboard`.

A created plan's shots can be reordered, edited and deleted, so a card isn't tied to a
shot's position: its id is a digest of what it draws (`storyboard_id`), and a shot whose
directions changed simply has no card until one is drawn for it.
"""

import hashlib

from app.schemas import Asset, Shot

GENERIC_PERSON = (
    "Anyone in it is a generic, anonymous adult, not a likeness of any real or recognisable person."
)
NO_TEXT = "No text, captions, labels, logos, brand names, watermarks or panel numbers anywhere."
# The shape every card is drawn in: the video's own.


def shot_directions(shot: Shot) -> list[str]:
    """What a picture of the shot shows: where, the framing, who or what, the feeling."""
    lens = "front (selfie)" if shot.camera == "front" else "rear"
    return [
        f"Where: {shot.scene}",
        f"Framing: a {shot.framing.shotSize} shot on the phone's {lens} camera, held at "
        f"{shot.phoneAngle.height} height. {shot.framing.note}",
        f"In it: {shot.pose.description}",
        f"Feeling: {shot.purpose}",
    ]


def storyboard_prompt(shot: Shot) -> str:
    return "\n".join(
        [
            "A single storyboard frame for one shot of a vertical 9:16 phone video, drawn as "
            "a clean pencil and grey-marker sketch on white paper.",
            *shot_directions(shot),
            GENERIC_PERSON,
            NO_TEXT,
        ]
    )


def storyboard_id(shot: Shot) -> str:
    """The card's id: a digest of its prompt, so the same directions keep the same card
    wherever the shot moves. Lowercase hex, which an asset id's pattern allows."""
    return "shot-" + hashlib.sha256(storyboard_prompt(shot).encode()).hexdigest()[:16]


def storyboard_asset(shot: Shot) -> Asset:
    """The shot's card as an image asset, so the asset job draws, stores and logs it like
    a default (director-assets/<planId>/<card id>.<ext>), in the video's own 9:16."""
    card = storyboard_id(shot)
    return Asset.model_validate(
        {
            "id": card,
            "kind": "image",
            "title": shot.title,
            "role": "The storyboard card for this shot",
            "description": shot.scene,
            "prompt": storyboard_prompt(shot),
            "sourceStartSeconds": shot.sourceStartSeconds,
            "sourceEndSeconds": max(shot.sourceEndSeconds, 0.1),
            "defaultSource": "create",
            "personalisable": False,
            "ask": None,
            "secondScreen": False,
            "reference": {
                "subject": shot.scene,
                "composition": shot.framing.note,
                "style": "Pencil and grey-marker storyboard sketch",
                "palette": "Black and white",
                "blackAndWhite": True,
                "aspectRatio": "9:16",
                "text": [],
                "brands": [],
                "mood": shot.purpose[:160],
            },
        }
    )
