"""
Live round-trip against a local Ollama + Gemma. Skipped unless RUN_GEMMA_INTEGRATION=1.

    # PowerShell
    $env:RUN_GEMMA_INTEGRATION = "1"; pytest tests/integration -q -s
    # bash
    RUN_GEMMA_INTEGRATION=1 pytest tests/integration -q -s

Requires Ollama running at OLLAMA_URL with OLLAMA_MODEL present. Expect the first call to take
several seconds while the model loads.
"""
from __future__ import annotations

import os

import pytest
from jsonschema import Draft202012Validator

from app.main import app
from app.reasoning import GemmaReasoner

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("RUN_GEMMA_INTEGRATION") != "1",
        reason="set RUN_GEMMA_INTEGRATION=1 to run against a live Ollama",
    ),
]


def test_gemma_round_trip(client, swap_state, example_context, schemas):
    health = client.get("/health/gemma", params={"warm": "true"})
    assert health.status_code == 200, f"Gemma is not ready: {health.json()}"
    print("\n/health/gemma:", health.json())

    swap_state(reasoner=GemmaReasoner(app.state.ollama, app.state.settings))

    context = {**example_context, "task": "Click the Submit button"}
    res = client.post("/process", json=context)
    assert res.status_code == 200, res.text

    command = res.json()
    print("/process ->", command)
    Draft202012Validator(schemas["command"]).validate(command)
    assert command["action"] == "click", command
    assert command["target"] == "el_1", command
