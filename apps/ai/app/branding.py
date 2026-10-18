"""Taking the original creator's own identity out of what the member's version shows: the
creator's, channel's, school's or business's name (the planner lists them, for the plan
and for each asset, in `brands`), and any handle or web address, whatever it lists. Each
is the original's own (spec 7.4: "the member's version gets their own name or none"), so
a default image (app/assets.py) and an edit's words (app/plan_repair.py) carry a neutral
placeholder there instead, for the member to make it theirs. A product or a tool the
Short is about ("Mastering Claude") is its topic, not its creator's identity, and stays.

Names match as whole words only ("Apple" never in "Pineapple"), and everything is
replaced in one pass, so a placeholder is never matched again.
"""

import re
from collections.abc import Callable, Iterable

PLACEHOLDER_NAME = "Your Name"
PLACEHOLDER_HANDLE = "@yourname"
PLACEHOLDER_WEBSITE = "yourwebsite.com"
# A web address: with a scheme, from www., or a domain whose every label has at least two
# characters ("mesa.school", never the "e.g.in" of ordinary text).
_WEB_ADDRESS = (
    r"(?<![\w.@])(?:https?://\S+|www\.\S+|(?:[A-Za-z0-9-]{2,}\.)+"
    r"(?:com|in|io|org|net|co|uk|app|ai|me|tv|dev|xyz|shop|store|school|academy|studio|"
    r"live|link|page|site)\b)"
)
_HANDLE = r"(?<![\w.])@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*"


def unbranding(brands: Iterable[str]) -> Callable[[str], str]:
    """What replaces the original's identity in a piece of text: any web address, any
    handle, and each of `brands` as a whole word (whatever its case, the longest first,
    so "Mesa School of Business" goes before "Mesa")."""
    names = sorted({brand.strip() for brand in brands if brand.strip()}, key=len, reverse=True)
    alternatives = [f"(?P<web>{_WEB_ADDRESS})", f"(?P<handle>{_HANDLE})"]
    if names:
        words = "|".join(re.escape(name) for name in names)
        alternatives.append(rf"(?P<brand>(?<!\w)(?:{words})(?!\w))")
    pattern = re.compile("|".join(alternatives), re.IGNORECASE)

    def placeholder(match: re.Match[str]) -> str:
        if match.group("web") is not None:
            return PLACEHOLDER_WEBSITE
        if match.group("handle") is not None:
            return PLACEHOLDER_HANDLE
        return PLACEHOLDER_NAME

    def unbranded(text: str) -> str:
        return pattern.sub(placeholder, text)

    return unbranded
