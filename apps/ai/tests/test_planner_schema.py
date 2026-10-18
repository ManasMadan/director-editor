"""The schema the planner sends Gemini, read from the request itself (through the local
Gemini API stand-in, tests/fakes.py): Vertex AI refuses some JSON Schema constructs
outright (it answered 400 to a `maxItems` once, failing every index), so the sent schema
keeps to the keywords and shapes this service has always sent it."""

import json
from collections.abc import Iterator

import pytest
from pydantic import JsonValue, TypeAdapter

from app.director import create_index_model, create_planner_agent
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


async def sent_schema() -> JsonValue:
    """The output tool's parameters, as the planner sends them."""
    with serve({GEMINI_PATH: gemini_output(PLAN)}) as fake:
        settings = GeminiSettings.model_validate(
            {"GOOGLE_API_KEY": "test-key", "GOOGLE_BASE_URL": fake.url, "GOOGLE_VERTEX": False}
        )
        await create_planner_agent(create_index_model(settings, GEMINI_MODEL)).run("plan")
        [(_, body)] = fake.received
    return _BODY.validate_json(body)["tools"]


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


async def test_the_sent_schema_keeps_to_what_vertex_has_always_accepted() -> None:
    tools = await sent_schema()
    [declaration] = [node for node in nodes(tools) if node.get("name") == "final_result"]
    schema = declaration["parameters_json_schema"]
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
    # Every property the planner answers with is required: nothing is left to a default.
    for node in nodes(schema):
        properties = node.get("properties")
        if isinstance(properties, dict):
            required = node["required"]
            assert isinstance(required, list)
            assert set(properties) == set(map(str, required))
