"""The summary workflow (LangGraph), with the local summarizer: no provider needed."""

import pytest
from pydantic_ai import UsageLimitExceeded
from pydantic_ai.usage import RunUsage, UsageLimits

from app.summaries import build_summary_graph, local_summarizer, summarize

LIMITS = UsageLimits(total_tokens_limit=20_000)


async def test_summarizes_each_passage_then_combines_them() -> None:
    usage = RunUsage()
    summary = await summarize(
        build_summary_graph(local_summarizer()),
        [
            "Refunds take five days. They go to the original card.",
            "Shipping is free over 50 euros. Otherwise it costs 5.",
            "Support answers within a day. Weekends are slower.",
            "Returns are accepted for 30 days. Items must be unused.",
        ],
        usage,
        LIMITS,
    )
    # One sentence per passage, then the combined summary keeps the first three.
    assert summary == (
        "Refunds take five days. Shipping is free over 50 euros. Support answers within a day."
    )
    assert usage.requests == 5  # four passages, one combine
    assert usage.input_tokens > 0


async def test_one_passage_needs_no_combining() -> None:
    usage = RunUsage()
    summary = await summarize(
        build_summary_graph(local_summarizer()),
        ["Only one thing here. And a detail."],
        usage,
        LIMITS,
    )
    assert summary == "Only one thing here."
    assert usage.requests == 1


async def test_nothing_to_summarize() -> None:
    usage = RunUsage()
    assert await summarize(build_summary_graph(local_summarizer()), [], usage, LIMITS) == ""
    assert usage.requests == 0


async def test_what_was_spent_is_still_counted_when_the_limit_stops_it() -> None:
    usage = RunUsage()
    with pytest.raises(UsageLimitExceeded):
        await summarize(
            build_summary_graph(local_summarizer()),
            ["A first passage. With detail.", "A second passage. With more detail."],
            usage,
            UsageLimits(total_tokens_limit=10),
        )
    assert usage.input_tokens > 0
