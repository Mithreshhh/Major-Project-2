import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

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
