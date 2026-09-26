import json
import os
from pathlib import Path

# Unit tests must never depend on a running Ollama: force the deterministic reasoner before the
# app's lifespan reads the environment. The integration tests build a GemmaReasoner explicitly.
os.environ["REASONER"] = "mock"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED = REPO_ROOT / "shared"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def example_context() -> dict:
    return load_json(SHARED / "examples" / "sanitized-context.example.json")


@pytest.fixture(scope="session")
def example_command() -> dict:
    return load_json(SHARED / "examples" / "action-command.example.json")


@pytest.fixture(scope="session")
def schemas() -> dict[str, dict]:
    return {
        "context": load_json(SHARED / "schema" / "sanitized-context.schema.json"),
        "command": load_json(SHARED / "schema" / "action-command.schema.json"),
    }


@pytest.fixture
def swap_state(client):
    """Temporarily replace attributes on app.state (reasoner, ollama) for one test."""
    saved: dict[str, object] = {}

    def _swap(**attrs):
        for name, value in attrs.items():
            if name not in saved:
                saved[name] = getattr(app.state, name)
            setattr(app.state, name, value)

    yield _swap

    for name, value in saved.items():
        setattr(app.state, name, value)
