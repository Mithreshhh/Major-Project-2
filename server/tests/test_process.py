from jsonschema import Draft202012Validator

from app.schemas import PROTOCOL_VERSION


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["protocolVersion"] == PROTOCOL_VERSION
    assert body["reasoner"] == "mock"


def test_process_returns_click_on_submit_button(client, example_context, schemas):
    res = client.post("/process", json=example_context)
    assert res.status_code == 200, res.text
    command = res.json()
    assert command["action"] == "click"
    assert command["target"] == "el_1"
    Draft202012Validator(schemas["command"]).validate(command)


def test_process_returns_noop_without_buttons(client, example_context):
    ctx = {**example_context, "elements": [e for e in example_context["elements"] if e["role"] != "button"]}
    res = client.post("/process", json=ctx)
    assert res.status_code == 200
    assert res.json()["action"] == "noop"


def test_process_rejects_wrong_major_protocol(client, example_context):
    res = client.post("/process", json={**example_context, "protocolVersion": "9.0.0"})
    assert res.status_code == 400


def test_process_rejects_unknown_field(client, example_context):
    res = client.post("/process", json={**example_context, "rawHtml": "<html>"})
    assert res.status_code == 422


def test_process_rejects_missing_required(client, example_context):
    ctx = dict(example_context)
    del ctx["elements"]
    res = client.post("/process", json=ctx)
    assert res.status_code == 422
