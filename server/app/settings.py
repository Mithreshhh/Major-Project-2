"""
Runtime configuration, read from environment variables.

Every knob has a local default so `uvicorn app.main:app` works against a stock Ollama install
with the LedgerGuard Gemma model already created. Values are read on each `get_settings()` call
so tests can flip them without re-importing the app.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "ledgerguard-gemma4-e2b-q4-0:latest"


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    #: "gemma" (default) talks to Ollama; "mock" keeps the deterministic stand-in (used by unit tests).
    reasoner: str
    #: Base URL of the Ollama HTTP API. (Ollama's own OLLAMA_HOST has no scheme, so a separate name.)
    ollama_url: str
    #: Model tag as shown by `ollama list`.
    ollama_model: str
    #: Per-request timeout. Local models can take a while on first load.
    ollama_timeout_s: float
    #: Context window requested from Ollama. Prompts stay well under this with the element cap.
    ollama_num_ctx: int
    #: Max tokens to generate. One JSON object needs far fewer.
    ollama_num_predict: int
    ollama_temperature: float
    #: How long Ollama keeps the model in memory after a request.
    ollama_keep_alive: str
    #: "auto" sends the screenshot only if the model advertises vision; "always" / "never" force it.
    send_screenshot: str
    #: Upper bound on UI elements described in one prompt (interactive ones win).
    max_prompt_elements: int
    #: Record received payloads and serve GET /debug/view ("What the AI sees").
    debug_view: bool
    #: Also write each recorded payload to this directory (empty string disables saving).
    debug_save_dir: str


def get_settings() -> Settings:
    return Settings(
        reasoner=os.getenv("REASONER", "gemma").strip().lower(),
        ollama_url=os.getenv("OLLAMA_URL", DEFAULT_OLLAMA_URL).strip().rstrip("/"),
        ollama_model=os.getenv("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL).strip(),
        ollama_timeout_s=_float("OLLAMA_TIMEOUT_S", 120.0),
        ollama_num_ctx=_int("OLLAMA_NUM_CTX", 8192),
        ollama_num_predict=_int("OLLAMA_NUM_PREDICT", 256),
        ollama_temperature=_float("OLLAMA_TEMPERATURE", 0.0),
        ollama_keep_alive=os.getenv("OLLAMA_KEEP_ALIVE", "10m").strip(),
        send_screenshot=os.getenv("GEMMA_SEND_SCREENSHOT", "auto").strip().lower(),
        max_prompt_elements=_int("GEMMA_MAX_ELEMENTS", 60),
        debug_view=_bool("ODPA_DEBUG_VIEW", True),
        debug_save_dir=os.getenv("ODPA_DEBUG_SAVE_DIR", "debug_captures").strip(),
    )
