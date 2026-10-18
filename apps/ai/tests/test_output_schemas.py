"""The schemas this service sends Gemini for its answers, read from the requests
themselves (through the local Gemini API stand-in, tests/fakes.py): Vertex AI refuses
some JSON Schema constructs outright (it answered 400 to a `maxItems` once, failing every
index), so every output schema keeps to the keywords and shapes this service has always
sent it. That holds for every agent, not only the planner: a review whose schema carried
a `maxItems` would fail every take."""

import json
import re
from collections.abc import Iterator
from contextlib import suppress
from pathlib import Path

import pytest
from pydantic import BaseModel, JsonValue, TypeAdapter
from pydantic_ai import Agent
from pydantic_ai.exceptions import UnexpectedModelBehavior

from app.aligning import AnchorSightingsDraft
from app.assets import SpellCheck
from app.director import create_index_model, create_planner_agent
from app.schemas import (
    BrainstormReplyDraft,
    EditorDraft,
    LocateDraft,
    PublishCopyDraft,
    RevisionDraft,
    ShotPlanDraft,
    TakeReviewDraft,
)
from app.session_pass import PassFindings
from app.settings import GeminiSettings
from tests.fakes import GEMINI_MODEL, GEMINI_PATH, gemini_output, serve
from tests.test_director import PLAN

pytestmark = pytest.mark.integration

# Every keyword the planner's schema used before assets and edits, which Vertex AI has
# accepted on every index since.
KEYWORDS = frozenset(
    {
        "$defs",
        "$ref",
        "anyOf",
        "description",
        "enum",
        "items",
        "maxLength",
        "maximum",
        "minLength",
        "minimum",
        "properties",
        "required",
        "type",
    }
)
_BODY = TypeAdapter(dict[str, JsonValue])

# Every model this service asks Gemini to answer with (an agent's `output_type`), by name.
OUTPUT_TYPES: dict[str, type[BaseModel]] = {
    model.__name__: model
    for model in (
        AnchorSightingsDraft,
        BrainstormReplyDraft,
        EditorDraft,
        LocateDraft,
        PassFindings,
        PublishCopyDraft,
        RevisionDraft,
        ShotPlanDraft,
        SpellCheck,
        TakeReviewDraft,
    )
}
APP = Path(__file__).parent.parent / "app"


def _settings(url: str) -> GeminiSettings:
    return GeminiSettings.model_validate(
        {"GOOGLE_API_KEY": "test-key", "GOOGLE_BASE_URL": url, "GOOGLE_VERTEX": False}
    )


def _final_result(body: bytes) -> JsonValue:
    """The output tool's parameters in a sent generateContent body."""
    tools = _BODY.validate_json(body)["tools"]
    [declaration] = [node for node in nodes(tools) if node.get("name") == "final_result"]
    return declaration["parameters_json_schema"]


async def planner_schema() -> JsonValue:
    """The output tool's parameters, as the planner sends them."""
    with serve({GEMINI_PATH: gemini_output(PLAN)}) as fake:
        await create_planner_agent(create_index_model(_settings(fake.url), GEMINI_MODEL)).run(
            "plan"
        )
        [(_, body)] = fake.received
    return _final_result(body)


async def sent_schema(output_type: type[BaseModel]) -> JsonValue:
    """The output tool's parameters an agent answering with `output_type` sends. The
    stand-in answers with nothing usable, so the run fails after its first request: only
    that request is read."""
    with serve({GEMINI_PATH: gemini_output({})}) as fake:
        model = create_index_model(_settings(fake.url), GEMINI_MODEL)
        with suppress(UnexpectedModelBehavior):
            await Agent(model, output_type=output_type).run("answer")
        body = fake.received[0][1]
    return _final_result(body)


def nodes(node: JsonValue) -> Iterator[dict[str, JsonValue]]:
    """Every schema object in `node`, not counting a `properties` map or `$defs` map
    themselves (their keys are names, not keywords)."""
    if isinstance(node, list):
        for item in node:
            yield from nodes(item)
    elif isinstance(node, dict):
        yield node
        for key, value in node.items():
            if key in {"properties", "$defs"} and isinstance(value, dict):
                for child in value.values():
                    yield from nodes(child)
            else:
                yield from nodes(value)


def assert_vertex_accepts(schema: JsonValue) -> None:
    sent = json.dumps(schema)
    assert '"default"' not in sent
    for node in nodes(schema):
        assert set(node) <= KEYWORDS, set(node) - KEYWORDS
        # A nullable field is a plain value or null: never a reference or an object.
        options = node.get("anyOf")
        if isinstance(options, list):
            assert len(options) == 2
            assert {"type": "null"} in options
            [value] = [option for option in options if option != {"type": "null"}]
            assert isinstance(value, dict)
            assert "$ref" not in value
            assert value.get("type") in {"string", "number", "integer", "boolean"}
    # Every property Gemini answers with is required: nothing is left to a default.
    for node in nodes(schema):
        properties = node.get("properties")
        if isinstance(properties, dict):
            required = node["required"]
            assert isinstance(required, list)
            assert set(properties) == set(map(str, required))


async def test_the_planners_schema_keeps_to_what_vertex_has_always_accepted() -> None:
    assert_vertex_accepts(await planner_schema())


@pytest.mark.parametrize("name", sorted(OUTPUT_TYPES))
async def test_every_output_schema_keeps_to_what_vertex_has_always_accepted(name: str) -> None:
    assert_vertex_accepts(await sent_schema(OUTPUT_TYPES[name]))


def test_every_agent_answers_with_a_type_checked_here() -> None:
    """An agent added with a new output type joins the list above, or this fails."""
    used = {
        found.group(1)
        for source in APP.rglob("*.py")
        for found in re.finditer(r"output_type=(\w+)", source.read_text())
    }
    assert used == set(OUTPUT_TYPES)
