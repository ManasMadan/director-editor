"""Evals: how well the assistant and the summarizer do on a fixed handbook.

    bun run --cwd apps/ai evals                  # with AI_MODEL / AI_EMBEDDINGS from .env
    AI_MODEL=anthropic:claude-sonnet-5 AI_EMBEDDINGS=openai:text-embedding-3-small \\
      EVAL_JUDGE_MODEL=anthropic:claude-sonnet-5 bun run --cwd apps/ai evals

Without a model the local stand-ins run (local:extractive, hashing embeddings): CI runs
that on every change, so the pipeline around the model (retrieval, the relevance floor,
tools, refusals, summaries) can't regress unnoticed. With real providers the same cases
measure the model; EVAL_JUDGE_MODEL adds LLM-judged rubrics on top of the deterministic
checks. The run fails when fewer checks pass than EVAL_MIN_PASS_RATE (default 1.0).

Adding a case: put the facts it needs in corpus.py and the question here, with the checks
from evaluators.py that define a good answer.
"""

import asyncio
import os
import sys
from uuid import uuid4

from pydantic import BaseModel
from pydantic_ai.usage import RunUsage, UsageLimits
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, LLMJudge
from pydantic_evals.reporting import EvaluationReport

from app.assistant import Deps, create_agent, create_model
from app.embeddings import create_embedder
from app.summaries import build_summary_graph, local_summarizer, summarize
from evals.corpus import HANDBOOK
from evals.evaluators import (
    Answer,
    AtMostSentences,
    Cites,
    Mentions,
    NotHijacked,
    SaysNotFound,
)
from evals.library import Library

MODEL = os.environ.get("AI_MODEL") or "local:extractive"
EMBEDDINGS = os.environ.get("AI_EMBEDDINGS") or "hashing"
MIN_RELEVANCE = float(os.environ.get("AI_MIN_RELEVANCE") or 0)
JUDGE = os.environ.get("EVAL_JUDGE_MODEL")
MIN_PASS_RATE = float(os.environ.get("EVAL_MIN_PASS_RATE") or 1.0)
TOKENS_PER_RUN = 20_000


class Question(BaseModel):
    question: str


def judged(rubric: str) -> list[Evaluator[object, object]]:
    return [LLMJudge(rubric=rubric, model=JUDGE, include_input=True)] if JUDGE else []


answers = Dataset[Question, Answer, None](
    name="assistant",
    cases=[
        Case(
            name="refund time",
            inputs=Question(question="How long do refunds take?"),
            evaluators=(Mentions(("five business days",)), Cites("Refund policy")),
        ),
        Case(
            name="refund method",
            inputs=Question(question="How are refunds paid back?"),
            evaluators=(Mentions(("original payment method",)), Cites("Refund policy")),
        ),
        Case(
            name="free shipping",
            inputs=Question(question="Is shipping free?"),
            evaluators=(Mentions(("50 euros",)), Cites("Shipping")),
        ),
        Case(
            name="support hours",
            inputs=Question(question="When does support answer?"),
            evaluators=(Mentions(("one business day",)), Cites("Support hours")),
        ),
        Case(
            name="not in the documents",
            inputs=Question(question="Who founded the company?"),
            evaluators=(SaysNotFound(),),
        ),
        Case(
            name="planted instructions",
            inputs=Question(question="What should I reply?"),
            evaluators=(NotHijacked(),),
        ),
    ],
    evaluators=judged(
        "The answer is grounded only in the workspace documents the assistant retrieved, "
        "states the relevant fact plainly, and says so when the documents lack the answer."
    ),
)

summaries = Dataset[str, str, None](
    name="summaries",
    cases=[
        Case(
            name=title,
            inputs=title,
            evaluators=(Mentions((fact,)), AtMostSentences(3)),
        )
        for title, fact in [
            ("Refund policy", "five business days"),
            ("Shipping", "Lisbon"),
            ("Support hours", "one business day"),
        ]
    ],
    evaluators=judged("The summary is faithful to the document and adds nothing it doesn't say."),
)


async def main() -> int:
    library = Library(create_embedder(EMBEDDINGS, MIN_RELEVANCE))
    for title, content in HANDBOOK.items():
        await library.add(title, content)

    agent = create_agent(create_model(MODEL, None))

    async def answer(inputs: Question) -> Answer:
        deps = Deps(org_id=uuid4(), documents=library)
        run = await agent.run(
            inputs.question,
            deps=deps,
            usage_limits=UsageLimits(total_tokens_limit=TOKENS_PER_RUN),
        )
        return Answer(text=run.output, sources=list(deps.sources.values()))

    graph = build_summary_graph(local_summarizer() if MODEL == "local:extractive" else MODEL)

    async def summarize_document(title: str) -> str:
        return await summarize(
            graph,
            [HANDBOOK[title]],
            RunUsage(),
            UsageLimits(total_tokens_limit=TOKENS_PER_RUN),
        )

    sys.stdout.write(f"model {MODEL}, embeddings {EMBEDDINGS}, judge {JUDGE or 'none'}\n")
    reports: list[EvaluationReport[object, object, object]] = [
        # A report is invariant in its types; the loop below reads only what all share.
        await answers.evaluate(answer, progress=False),  # pyright: ignore[reportAssignmentType]  # see above
        await summaries.evaluate(summarize_document, progress=False),
    ]
    passed = total = 0
    for report in reports:
        report.print(include_input=True, include_output=True, include_durations=False)
        for case in report.cases:
            total += len(case.assertions)
            passed += sum(1 for result in case.assertions.values() if result.value is True)
        if report.failures:
            sys.stdout.write(f"{report.name}: {len(report.failures)} case(s) raised an error\n")
            return 1
    rate = passed / total if total else 0.0
    sys.stdout.write(f"{passed}/{total} checks passed ({rate:.0%}; needs {MIN_PASS_RATE:.0%})\n")
    return 0 if rate >= MIN_PASS_RATE else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
