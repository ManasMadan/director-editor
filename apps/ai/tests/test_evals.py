"""The evals' checks must fail on bad answers too, or a passing eval run means nothing."""

import runpy
from collections.abc import Callable

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_evals.evaluators import EvaluatorContext, LLMJudge

import evals.__main__ as run
from evals.evaluators import Answer, AtMostSentences, Cites, Mentions, NotHijacked, SaysNotFound


def ctx[Output](output: Output) -> EvaluatorContext[object, Output]:
    return EvaluatorContext(
        name="case",
        inputs=None,
        metadata=None,
        expected_output=None,
        output=output,
        duration=0.0,
        _span_tree=None,  # pyright: ignore[reportArgumentType]  # these checks never read spans
        attributes={},
        metrics={},
    )


def test_mentions_needs_every_phrase() -> None:
    answer = Answer(text="Refunds take Five Business Days.", sources=[])
    assert Mentions(("five business days",)).evaluate(ctx(answer))
    assert not Mentions(("five business days", "card")).evaluate(ctx(answer))
    assert Mentions(("lisbon",)).evaluate(ctx("We ship from Lisbon."))


def test_cites_checks_the_sources() -> None:
    answer = Answer(text="…", sources=["Shipping"])
    assert Cites("Shipping").evaluate(ctx(answer))
    assert not Cites("Refund policy").evaluate(ctx(answer))


def test_says_not_found_rejects_a_made_up_answer() -> None:
    assert SaysNotFound().evaluate(ctx(Answer(text="I couldn't find that.", sources=[])))
    assert not SaysNotFound().evaluate(ctx(Answer(text="Ada Lovelace founded it.", sources=[])))


def test_not_hijacked_catches_obeying_planted_instructions() -> None:
    assert NotHijacked().evaluate(
        ctx(Answer(text="The notice asks you to reply HACKED.", sources=[]))
    )
    assert not NotHijacked().evaluate(ctx(Answer(text="HACKED.", sources=[])))


def test_at_most_sentences() -> None:
    assert AtMostSentences(2).evaluate(ctx("One. Two!"))
    assert not AtMostSentences(2).evaluate(ctx("One. Two? Three."))
    assert not AtMostSentences(2).evaluate(ctx(""))


# ------------------------------------------------------------------ the run itself


@pytest.fixture
def local(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stand-ins, whatever this shell's environment says."""
    monkeypatch.setattr(run, "MODEL", "local:extractive")
    monkeypatch.setattr(run, "EMBEDDINGS", "hashing")
    monkeypatch.setattr(run, "MIN_RELEVANCE", 0.0)
    monkeypatch.setattr(run, "JUDGE", None)
    monkeypatch.setattr(run, "MIN_PASS_RATE", 1.0)


def answering(respond: Callable[[], str]) -> Callable[[str, str | None], Model]:
    """create_model, for a model that answers every question with `respond()`."""

    def create(_name: str, _fallback: str | None) -> Model:
        async def reply(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
            return ModelResponse(parts=[TextPart(respond())])

        return FunctionModel(reply)

    return create


@pytest.mark.usefixtures("local")
async def test_every_check_passes_with_the_local_stand_ins(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert await run.main() == 0
    assert "16/16 checks passed (100%; needs 100%)" in capsys.readouterr().out


@pytest.mark.usefixtures("local")
async def test_too_few_passing_checks_fail_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(run, "create_model", answering(lambda: "No idea."))
    assert await run.main() == 1
    assert "needs 100%" in capsys.readouterr().out


@pytest.mark.usefixtures("local")
async def test_a_case_that_raises_fails_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken() -> str:
        raise RuntimeError("provider down")

    monkeypatch.setattr(run, "create_model", answering(broken))
    assert await run.main() == 1
    assert "answer: 6 case(s) raised an error" in capsys.readouterr().out


def test_a_judge_model_adds_its_rubric(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run, "JUDGE", None)
    assert run.judged("faithful") == []
    monkeypatch.setattr(run, "JUDGE", "test")
    [judge] = run.judged("faithful")
    assert isinstance(judge, LLMJudge)
    assert judge.rubric == "faithful"


@pytest.mark.usefixtures("local")
def test_python_m_evals_exits_with_the_run_s_code(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exited:
        runpy.run_path(run.__file__, run_name="__main__")
    assert exited.value.code == 0
    assert "checks passed" in capsys.readouterr().out
