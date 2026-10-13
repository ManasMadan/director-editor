"""The "model". Replace this module with real inference.

It is a tiny word-list classifier so the example runs instantly with no downloads.
To use a real model, load it once at startup in `lifespan` (app/main.py) and call it
from `predict`. For example with Hugging Face transformers:

    from transformers import pipeline
    classifier = pipeline("sentiment-analysis")      # load once, reuse per request
    result = classifier(text)[0]                     # {"label": "POSITIVE", "score": 0.99}

Heavy inference is CPU/GPU-bound: declare the endpoint with plain `def` (not
`async def`) so FastAPI runs it in a worker thread and the event loop stays free.
See docs/python-services.md.
"""

from typing import Literal

MODEL_ID = "wordlist-v1"

_POSITIVE = {"good", "great", "love", "excellent", "awesome", "happy", "nice", "amazing"}
_NEGATIVE = {"bad", "terrible", "hate", "awful", "sad", "poor", "horrible", "worst"}


def predict(text: str) -> tuple[Literal["positive", "negative", "neutral"], float]:
    words = [w.strip(".,!?;:").lower() for w in text.split()]
    pos = sum(w in _POSITIVE for w in words)
    neg = sum(w in _NEGATIVE for w in words)
    if pos == neg:
        return "neutral", 0.5
    label: Literal["positive", "negative"] = "positive" if pos > neg else "negative"
    return label, round(max(pos, neg) / (pos + neg), 4)
