"""
Contract tests: the shared examples must satisfy the JSON Schemas AND the Pydantic models.
If either side of the contract drifts, these fail.
"""
import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.schemas import PROTOCOL_VERSION, SanitizedContext
from pydantic import TypeAdapter

from app.schemas import ActionCommand


def _validator(schemas: dict[str, dict], which: str) -> Draft202012Validator:
    registry = Registry().with_resources(
        (s["$id"], Resource.from_contents(s)) for s in schemas.values()
    )
    return Draft202012Validator(schemas[which], registry=registry, format_checker=FormatChecker())


def test_example_context_matches_json_schema(schemas, example_context):
    _validator(schemas, "context").validate(example_context)


def test_example_command_matches_json_schema(schemas, example_command):
    _validator(schemas, "command").validate(example_command)


def test_example_context_matches_pydantic(example_context):
    ctx = SanitizedContext.model_validate(example_context)
    assert ctx.protocolVersion == PROTOCOL_VERSION


def test_example_command_matches_pydantic(example_command):
    cmd = TypeAdapter(ActionCommand).validate_python(example_command)
    assert cmd.action == "click"


@pytest.mark.parametrize(
    "command",
    [
        {"action": "click", "target": "el_1"},
        {"action": "type", "target": "el_0", "text": "hello", "submit": True},
        {"action": "scroll", "direction": "down"},
        {"action": "navigate", "url": "https://example.com/"},
        {"action": "wait", "ms": 500},
        {"action": "done", "summary": "finished"},
        {"action": "ask_user", "question": "Which account?"},
        {"action": "noop", "reason": "loading"},
    ],
)
def test_every_action_variant_agrees(schemas, command):
    _validator(schemas, "command").validate(command)
    TypeAdapter(ActionCommand).validate_python(command)


def test_unknown_field_rejected_by_both(schemas, example_command):
    bad = {**example_command, "extra": 1}
    assert not _validator(schemas, "command").is_valid(bad)
    with pytest.raises(Exception):
        TypeAdapter(ActionCommand).validate_python(bad)
