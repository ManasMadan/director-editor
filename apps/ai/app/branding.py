"""Taking the original creator's branding out of what the member's version shows: a brand,
a product or company name, the creator's or channel's own name (the planner lists them
in each asset's `reference.brands`), and any handle or web address, whatever it lists.
Each is the original's own (spec 7.4: "the member's version gets their own name or
none"), so a default image (app/assets.py) and an edit's words (app/plan_repair.py)
carry a neutral placeholder there instead, for the member to make it theirs.
"""

import re
from collections.abc import Callable, Iterable

PLACEHOLDER_NAME = "Your Name"
PLACEHOLDER_HANDLE = "@yourname"
PLACEHOLDER_WEBSITE = "yourwebsite.com"
_HANDLE = re.compile(r"(?<![\w.])@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")
_WEB_ADDRESS = re.compile(
    r"\b(?:https?://\S+|www\.\S+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|in|io|org|net|co|"
    r"uk|app|ai|me|tv|dev|xyz|shop|store|school|academy|studio|live|link|page|site)\b)",
    re.IGNORECASE,
)


def unbranding(brands: Iterable[str]) -> Callable[[str], str]:
    """What replaces the branding in a piece of text: each of `brands` (whatever its
    case, the longest first, so "Mesa School of Business" goes before "Mesa"), any handle
    and any web address."""
    names = sorted({brand.strip() for brand in brands if brand.strip()}, key=len, reverse=True)
    brand = (
        re.compile("|".join(re.escape(name) for name in names), re.IGNORECASE) if names else None
    )

    def unbranded(text: str) -> str:
        text = _WEB_ADDRESS.sub(PLACEHOLDER_WEBSITE, text)
        text = _HANDLE.sub(PLACEHOLDER_HANDLE, text)
        return brand.sub(PLACEHOLDER_NAME, text) if brand else text

    return unbranded
