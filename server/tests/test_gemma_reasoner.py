"""
Unit tests for the Gemma/Ollama path. No network: Ollama is replaced by an httpx.MockTransport
that returns scripted replies, so these run in milliseconds alongside the mock-reasoner tests.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from app.ollama import OllamaClient, OllamaUnavailableError
from app.prompting import (
    ActionParseError,
    build_messages,
    describe_location,
    parse_action,
)
from app.reasoning import GemmaReasoner, ModelOutputError
from app.schemas import BoundingBox, SanitizedContext, Viewport
from app.settings import get_settings

MODEL = "ledgerguard-gemma4-e2b-q4-0:latest"
CLICK_EL1 = '{"action": "click", "target": "el_1", "reasoning": "submit finishes the task"}'


def run(coro):
    return asyncio.run(coro)


def make_context(example_context: dict, **overrides: Any) -> SanitizedContext:
    return SanitizedContext.model_validate({**example_context, **overrides})


class FakeOllama:
    """Scripted Ollama server. `replies` are returned by /api/chat in order."""

    def __init__(
        self,
        replies: list[str | Exception],
        *,
        capabilities: tuple[str, ...] = ("completion", "thinking"),
        models: tuple[str, ...] = (MODEL,),
        running: tuple[str, ...] = (),
        unreachable: bool = False,
    ) -> None:
        self.replies = list(replies)
        self.capabilities = list(capabilities)
        self.models = list(models)
        self.running = list(running)
        self.unreachable = unreachable
        self.chat_requests: list[dict[str, Any]] = []
        self.warm_requests: list[Any] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.0-test"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.models]})
        if path == "/api/ps":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.running]})
        if path == "/api/show":
            body = json.loads(request.content)
            if body.get("model") not in self.models:
                return httpx.Response(404, json={"error": f"model '{body.get('model')}' not found"})
            return httpx.Response(
                200,
                json={"capabilities": self.capabilities, "details": {"family": "gemma4"}, "model_info": {}},
            )
        if path == "/api/generate":
            self.warm_requests.append(json.loads(request.content).get("options"))
            self.running = list(self.models)
            return httpx.Response(200, json={"done": True})
        if path == "/api/chat":
            self.chat_requests.append(json.loads(request.content))
            if not self.replies:
                return httpx.Response(500, json={"error": "fake ran out of scripted replies"})
            reply = self.replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return httpx.Response(200, json={"message": {"role": "assistant", "content": reply}, "done": True})
        return httpx.Response(404, json={"error": f"unexpected path {path}"})

    def client(self) -> OllamaClient:
        return OllamaClient("http://ollama.test", MODEL, transport=httpx.MockTransport(self.handler))

    def reasoner(self) -> GemmaReasoner:
        return GemmaReasoner(self.client(), get_settings())


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


def test_prompt_describes_task_and_elements(example_context):
    ctx = make_context(example_context)
    messages = build_messages(ctx, max_elements=60, include_screenshot=False)

    assert [m["role"] for m in messages] == ["system", "user"]
    system, user = messages[0]["content"], messages[1]["content"]
    assert '"action": "click"' in system and "ONE JSON object" in system
    assert "Task: Submit the contact form" in user
    assert "el_0 | textbox" in user and "el_1 | button" in user
    assert '"Submit"' in user and "type=email" in user
    assert "Redacted regions: 1" in user
    assert "images" not in messages[1]


def test_prompt_attaches_screenshot_only_when_asked(example_context):
    shot = {"mimeType": "image/png", "dataBase64": "aGVsbG8=", "width": 2, "height": 2}
    ctx = make_context(example_context, screenshot=shot)
    with_img = build_messages(ctx, max_elements=60, include_screenshot=True)
    without = build_messages(ctx, max_elements=60, include_screenshot=False)
    assert with_img[1]["images"] == ["aGVsbG8="]
    assert "images" not in without[1]


def test_prompt_caps_elements_and_prefers_interactive(example_context):
    heading = {
        "id": "el_x", "role": "heading", "label": "Welcome",
        "bbox": {"x": 0, "y": 0, "width": 100, "height": 20}, "isVisible": True, "isInteractive": False,
    }
    elements = [dict(heading, id=f"el_{i}") for i in range(30)]
    elements.append({**example_context["elements"][1], "id": "el_30"})  # the Submit button, last in DOM
    ctx = make_context(example_context, elements=elements)

    user = build_messages(ctx, max_elements=5, include_screenshot=False)[1]["content"]
    assert "el_30 | button" in user
    assert "(26 more elements omitted)" in user
    assert user.count(" | heading | ") == 4


def test_prompt_surfaces_page_messages_for_completion(example_context):
    status = {
        "id": "el_9", "role": "text", "label": "Form submitted. Thanks!",
        "bbox": {"x": 100, "y": 320, "width": 200, "height": 20}, "isVisible": True, "isInteractive": False,
    }
    ctx = make_context(example_context, elements=[*example_context["elements"], status],
                       history=[{"action": "click", "target": "el_1"}], stepIndex=1)
    messages = build_messages(ctx, max_elements=60, include_screenshot=False)
    user = messages[1]["content"]
    assert 'Page messages:\n  "Form submitted. Thanks!"' in user
    assert "all already done successfully" in user
    assert '"done"' in messages[0]["content"] and "Page messages" in messages[0]["content"]


def test_prompt_lists_history(example_context):
    history = [{"action": "type", "target": "el_0", "text": "a@b.c"}, {"action": "scroll", "direction": "down"}]
    ctx = make_context(example_context, history=history, stepIndex=2)
    user = build_messages(ctx, max_elements=60, include_screenshot=False)[1]["content"]
    assert 'type "a@b.c" into el_0' in user and "scroll down" in user and "Step: 2" in user


@pytest.mark.parametrize(
    ("x", "y", "expected"),
    [
        (0, 0, "top-left"),
        (600, 20, "top"),
        (1200, 20, "top-right"),
        (20, 350, "left"),
        (600, 350, "center"),
        (1200, 350, "right"),
        (20, 700, "bottom-left"),
        (600, 700, "bottom"),
        (1200, 700, "bottom-right"),
    ],
)
def test_describe_location_grid(x, y, expected):
    vp = Viewport(width=1280, height=720, scrollX=0, scrollY=0, devicePixelRatio=1)
    assert describe_location(BoundingBox(x=x, y=y, width=10, height=10), vp) == expected


# ---------------------------------------------------------------------------
# Parsing: what small models actually emit
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (CLICK_EL1, {"action": "click", "target": "el_1"}),
        ("```json\n" + CLICK_EL1 + "\n```", {"action": "click", "target": "el_1"}),
        ("Sure! The next action is: " + CLICK_EL1 + " Hope this helps.", {"action": "click", "target": "el_1"}),
        ('{"type": "click", "element_id": "el_1", "explanation": "x"}', {"action": "click", "target": "el_1", "reasoning": "x"}),
        ('{"action": "click", "target": 1}', {"action": "click", "target": "el_1"}),
        ('{"action": "click", "target": "1"}', {"action": "click", "target": "el_1"}),
        ('{"action": "click", "target": "element 1"}', {"action": "click", "target": "el_1"}),
        ('{"action": "click", "target": "Submit"}', {"action": "click", "target": "el_1"}),
        ('{"action": "click el_1"}', {"action": "click", "target": "el_1"}),
        ('{"action": "press", "target": "el_1"}', {"action": "click", "target": "el_1"}),
        ('{"command": {"action": "noop", "reason": "nothing to do"}}', {"action": "noop", "reason": "nothing to do"}),
        ('[{"action": "click", "target": "el_1"}]', {"action": "click", "target": "el_1"}),
        ("{'action': 'done', 'summary': 'ok',}", {"action": "done", "summary": "ok"}),
        ('{"action": "fill", "element": "el_0", "value": "a@b.c", "press_enter": "yes"}',
         {"action": "type", "target": "el_0", "text": "a@b.c", "submit": True}),
        ('{"action": "scroll_down"}', {"action": "scroll", "direction": "down"}),
        ('{"action": "scroll", "direction": "bottom"}', {"action": "scroll", "direction": "down"}),
        ('{"action": "done", "reasoning": "all done"}', {"action": "done", "summary": "all done"}),
        ('{"action": "noop", "reason": "x", "target": null, "text": null}', {"action": "noop", "reason": "x"}),
        ('{"action": "click", "target": "el_1", "confidence": 85}', {"action": "click", "target": "el_1", "confidence": 0.85}),
        ('{"action": "wait", "seconds": 2}', {"action": "wait", "ms": 2000}),
        ('{"action": "navigate", "href": "https://example.com/next"}', {"action": "navigate", "url": "https://example.com/next"}),
        ('{"target": "el_0", "text": "hi"}', {"action": "type", "target": "el_0", "text": "hi"}),
        ('{"action": "ask_user", "text": "Which account?"}', {"action": "ask_user", "question": "Which account?"}),
    ],
)
def test_parse_action_tolerates_messy_output(example_context, raw, expected):
    ctx = make_context(example_context)
    command = parse_action(raw, ctx).model_dump(exclude_none=True)
    for key, value in expected.items():
        assert command[key] == value, f"{key}: {command}"


@pytest.mark.parametrize(
    ("raw", "fragment"),
    [
        ("", "empty"),
        ("I am not able to decide.", "no JSON object"),
        ('{"action": "dance", "target": "el_1"}', "unknown action"),
        ('{"action": "click", "target": "el_99"}', "unknown target 'el_99'"),
        ('{"action": "click", "target": "Nonexistent label"}', "unknown target"),
        ('{"action": "click"}', "target"),
        ('{"action": "navigate"}', "url"),
        ('{"action": "wait", "ms": -5}', "ms"),
    ],
)
def test_parse_action_rejects_unusable_output(example_context, raw, fragment):
    ctx = make_context(example_context)
    with pytest.raises(ActionParseError) as excinfo:
        parse_action(raw, ctx)
    assert fragment in str(excinfo.value)


# ---------------------------------------------------------------------------
# Reasoner behaviour against the fake Ollama
# ---------------------------------------------------------------------------


def test_reasoner_happy_path_and_request_shape(example_context):
    fake = FakeOllama([CLICK_EL1])
    command = run(fake.reasoner().decide(make_context(example_context)))

    assert command.action == "click" and command.target == "el_1"
    assert len(fake.chat_requests) == 1
    req = fake.chat_requests[0]
    assert req["model"] == MODEL
    assert req["format"] == "json"
    assert req["stream"] is False
    assert req["think"] is False  # model advertises thinking -> explicitly disabled
    assert req["options"]["temperature"] == 0
    assert "images" not in req["messages"][1]


def test_reasoner_omits_think_flag_for_models_without_thinking(example_context):
    fake = FakeOllama([CLICK_EL1], capabilities=("completion",))
    run(fake.reasoner().decide(make_context(example_context)))
    assert "think" not in fake.chat_requests[0]


def test_reasoner_sends_screenshot_only_if_model_has_vision(example_context):
    shot = {"mimeType": "image/png", "dataBase64": "aGVsbG8=", "width": 2, "height": 2}
    ctx = make_context(example_context, screenshot=shot)

    no_vision = FakeOllama([CLICK_EL1], capabilities=("completion",))
    run(no_vision.reasoner().decide(ctx))
    assert "images" not in no_vision.chat_requests[0]["messages"][1]

    vision = FakeOllama([CLICK_EL1], capabilities=("completion", "vision"))
    run(vision.reasoner().decide(ctx))
    assert vision.chat_requests[0]["messages"][1]["images"] == ["aGVsbG8="]


def test_reasoner_retries_once_with_feedback(example_context):
    fake = FakeOllama(['{"action": "click", "target": "el_99"}', CLICK_EL1])
    command = run(fake.reasoner().decide(make_context(example_context)))

    assert command.action == "click" and command.target == "el_1"
    assert len(fake.chat_requests) == 2
    retry_messages = fake.chat_requests[1]["messages"]
    assert retry_messages[-2]["role"] == "assistant" and "el_99" in retry_messages[-2]["content"]
    assert retry_messages[-1]["role"] == "user" and "unknown target 'el_99'" in retry_messages[-1]["content"]


def test_reasoner_gives_up_after_second_failure(example_context):
    fake = FakeOllama(["not json at all", '{"action": "teleport"}'])
    with pytest.raises(ModelOutputError) as excinfo:
        run(fake.reasoner().decide(make_context(example_context)))
    assert "after 2 attempts" in str(excinfo.value)
    assert excinfo.value.attempts == ["not json at all", '{"action": "teleport"}']


def test_reasoner_surfaces_ollama_down(example_context):
    fake = FakeOllama([], unreachable=True)
    with pytest.raises(OllamaUnavailableError):
        run(fake.reasoner().decide(make_context(example_context)))


# ---------------------------------------------------------------------------
# HTTP layer: error mapping and /health/gemma
# ---------------------------------------------------------------------------


def test_process_returns_502_when_model_output_unusable(client, swap_state, example_context):
    fake = FakeOllama(["garbage", "more garbage"])
    swap_state(reasoner=fake.reasoner())

    res = client.post("/process", json=example_context)
    assert res.status_code == 502
    body = res.json()
    assert "after 2 attempts" in body["detail"]
    assert body["attempts"] == ["garbage", "more garbage"]


def test_process_returns_503_when_ollama_unreachable(client, swap_state, example_context):
    fake = FakeOllama([], unreachable=True)
    swap_state(reasoner=fake.reasoner())

    res = client.post("/process", json=example_context)
    assert res.status_code == 503
    assert "Ollama" in res.json()["detail"]
    assert "/health/gemma" in res.json()["hint"]


def test_process_returns_503_when_model_missing(client, swap_state, example_context):
    fake = FakeOllama([CLICK_EL1], models=("some-other-model:latest",))
    swap_state(reasoner=fake.reasoner())

    res = client.post("/process", json=example_context)
    assert res.status_code == 503
    assert "not available" in res.json()["detail"]


def test_process_happy_path_through_http(client, swap_state, example_context, schemas):
    from jsonschema import Draft202012Validator

    fake = FakeOllama([CLICK_EL1])
    swap_state(reasoner=fake.reasoner())

    res = client.post("/process", json=example_context)
    assert res.status_code == 200, res.text
    Draft202012Validator(schemas["command"]).validate(res.json())
    assert res.json()["target"] == "el_1"


def test_health_gemma_ok_not_loaded(client, swap_state):
    fake = FakeOllama([])
    swap_state(ollama=fake.client())

    res = client.get("/health/gemma")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["reachable"] and body["modelAvailable"] and not body["modelLoaded"]
    assert body["capabilities"] == ["completion", "thinking"]
    assert "warm=true" in body["detail"]


def test_health_gemma_warm_loads_model(client, swap_state):
    fake = FakeOllama([])
    swap_state(ollama=fake.client())

    res = client.get("/health/gemma", params={"warm": "true"})
    assert res.status_code == 200
    assert res.json()["modelLoaded"] is True
    # Warmed with the context size real requests use, or Ollama reloads the model on step 1.
    assert fake.warm_requests == [{"num_ctx": get_settings().ollama_num_ctx}]


def test_health_gemma_model_missing(client, swap_state):
    fake = FakeOllama([], models=("llama3:latest",))
    swap_state(ollama=fake.client())

    res = client.get("/health/gemma")
    assert res.status_code == 503
    body = res.json()
    assert body["status"] == "model_missing" and body["reachable"] and not body["modelAvailable"]
    assert "llama3:latest" in body["detail"]


def test_health_gemma_unreachable(client, swap_state):
    fake = FakeOllama([], unreachable=True)
    swap_state(ollama=fake.client())

    res = client.get("/health/gemma")
    assert res.status_code == 503
    body = res.json()
    assert body["status"] == "unavailable" and not body["reachable"]
    assert "ollama serve" in body["detail"]


def test_prompt_lists_saved_details_by_name_only(example_context):
    ctx = make_context(
        example_context,
        task="Fill this form with my details",
        profileFields=[{"key": "full_name", "label": "Full name"}, {"key": "email", "label": "Email"}],
        history=[{"action": "type", "target": "el_0", "text": "{{email}}"}],
    )
    system, user = (m["content"] for m in build_messages(ctx, max_elements=60, include_screenshot=False))
    assert '"text": "{{email}}"' in system and "Their values are hidden from you" in system
    assert "{{full_name}} = Full name" in user and "{{email}} = Email" in user
    assert "Already typed: {{email}}. Do not type these again." in user


def test_profile_fields_reject_values_smuggled_as_extra_keys(client, example_context):
    bad = {**example_context, "profileFields": [{"key": "email", "label": "Email", "value": "jane@example.com"}]}
    assert client.post("/process", json=bad).status_code == 422
