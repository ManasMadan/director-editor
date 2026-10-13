"""Reading a run's messages, for the local stand-in models (development and tests; no
provider)."""

from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart


def user_prompt(messages: list[ModelMessage]) -> str:
    """The text the run was started with."""
    prompts = [
        part.content
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if part.part_kind == "user-prompt" and isinstance(part.content, str)
    ]
    return prompts[0] if prompts else ""


def last_tool_return(messages: list[ModelMessage]) -> str | None:
    """What the latest tool call returned, once one has."""
    returns = [
        str(part.content)
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    return returns[-1] if returns else None
