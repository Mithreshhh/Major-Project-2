"""
Server-side reasoning: SanitizedContext -> ActionCommand.

  GemmaReasoner  (default)  prompts a local Gemma model through Ollama, parses the reply into
                            an ActionCommand, retries once with feedback if the reply is
                            unusable, then raises ModelOutputError (HTTP 502) instead of crashing.
  MockReasoner              deterministic stand-in with no external dependency; used by the
                            fast unit tests and available via REASONER=mock.
"""
from __future__ import annotations

import logging
from typing import Optional, Protocol

from .ollama import OllamaClient
from .prompting import (
    ActionParseError,
    build_ask_messages,
    build_messages,
    describe_redactions,
    parse_action,
    retry_prompt,
)
from .schemas import ActionCommand, ClickAction, DoneAction, NoopAction, SanitizedContext
from .settings import Settings

log = logging.getLogger("odpa.reasoning")

_SNIPPET = 400


class ReasonerError(Exception):
    """Base class for failures the API layer turns into structured HTTP errors."""

    status_code = 502

    def __init__(self, detail: str, *, attempts: Optional[list[str]] = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.attempts = [a[:_SNIPPET] for a in (attempts or [])]


class ModelOutputError(ReasonerError):
    """The model answered, but not with anything we could turn into a valid ActionCommand."""


class Reasoner(Protocol):
    name: str

    async def decide(self, context: SanitizedContext) -> ActionCommand: ...

    async def answer(self, context: SanitizedContext) -> str: ...


# ---------------------------------------------------------------------------
# Mock
# ---------------------------------------------------------------------------


class MockReasoner:
    """
    Deterministic stand-in for the model.

    Picks the first visible, interactive button (preferring one labelled "submit"), otherwise
    reports that there is nothing to do. Exists so the client and the tests never need Ollama.
    """

    name = "mock"

    async def decide(self, context: SanitizedContext) -> ActionCommand:
        if context.stepIndex >= 5:
            return DoneAction(action="done", summary="Mock reasoner stops after 5 steps.", confidence=1.0)

        buttons = [e for e in context.elements if e.role == "button" and e.isInteractive and e.isVisible]
        preferred = next((b for b in buttons if "submit" in b.label.lower()), None) or (buttons[0] if buttons else None)

        if preferred is not None:
            return ClickAction(
                action="click",
                target=preferred.id,
                reasoning=f"[mock] clicking first candidate button '{preferred.label}'",
                confidence=0.5,
            )

        return NoopAction(
            action="noop",
            reason="[mock] no interactive button found in the sanitized context",
            confidence=0.5,
        )

    async def answer(self, context: SanitizedContext) -> str:
        words = len((context.pageText or "").split())
        return (
            f"[mock] '{context.page.title}' has {len(context.elements)} elements and {words} words of text. "
            f"Hidden before sending: {describe_redactions(context)}."
        )


# ---------------------------------------------------------------------------
# Gemma via Ollama
# ---------------------------------------------------------------------------


class GemmaReasoner:
    """
    One decision = one (occasionally two) chat calls to Ollama.

    Flow:
      1. look up model capabilities once (vision? thinking?) to shape the request
      2. build the strict JSON prompt from the sanitized context
      3. call /api/chat in JSON mode with temperature 0
      4. parse; on failure send the bad reply back with the error and ask once more
      5. still unusable -> ModelOutputError (502) carrying both raw attempts for debugging
    """

    name = "gemma"

    def __init__(self, client: OllamaClient, settings: Settings) -> None:
        self._client = client
        self._settings = settings

    @property
    def model(self) -> str:
        return self._client.model

    async def _include_screenshot(self, context: SanitizedContext) -> bool:
        if context.screenshot is None:
            return False
        mode = self._settings.send_screenshot
        if mode == "never":
            return False
        if mode == "always":
            return True
        info = await self._client.model_info()
        return info.supports_vision

    async def _think_flag(self) -> Optional[bool]:
        """Disable thinking on models that support it; omit the flag for the rest."""
        info = await self._client.model_info()
        return False if info.supports_thinking else None

    def _options(self) -> dict[str, float | int]:
        s = self._settings
        return {
            "temperature": s.ollama_temperature,
            "num_predict": s.ollama_num_predict,
            "num_ctx": s.ollama_num_ctx,
        }

    async def decide(self, context: SanitizedContext) -> ActionCommand:
        include_image = await self._include_screenshot(context)
        think = await self._think_flag()
        messages = build_messages(
            context,
            max_elements=self._settings.max_prompt_elements,
            include_screenshot=include_image,
        )
        options = self._options()

        first_raw = await self._client.chat(messages, json_mode=True, think=think, options=options)
        try:
            command = parse_action(first_raw, context)
        except ActionParseError as exc:
            first_error = str(exc)
            log.warning("gemma reply rejected (attempt 1/2): %s | raw=%r", first_error, first_raw[:_SNIPPET])
        else:
            log.info("gemma step=%d -> %s", context.stepIndex, command.action)
            return command

        retry_messages = [
            *messages,
            {"role": "assistant", "content": first_raw},
            {"role": "user", "content": retry_prompt(first_error)},
        ]
        second_raw = await self._client.chat(retry_messages, json_mode=True, think=think, options=options)
        try:
            command = parse_action(second_raw, context)
        except ActionParseError as second_err:
            log.error("gemma reply rejected (attempt 2/2): %s | raw=%r", second_err, second_raw[:_SNIPPET])
            raise ModelOutputError(
                f"model '{self.model}' did not return a usable ActionCommand after 2 attempts: {second_err}",
                attempts=[first_raw, second_raw],
            ) from second_err

        log.info("gemma step=%d -> %s (after retry)", context.stepIndex, command.action)
        return command

    async def answer(self, context: SanitizedContext) -> str:
        """Plain-text answer about the page. Text only: the page text carries what matters."""
        options = {**self._options(), "num_predict": max(self._settings.ollama_num_predict, 600)}
        raw = await self._client.chat(
            build_ask_messages(context), json_mode=False, think=await self._think_flag(), options=options
        )
        text = raw.strip()
        if not text:
            raise ModelOutputError(f"model '{self.model}' returned an empty answer", attempts=[raw])
        log.info("gemma answered (%d chars)", len(text))
        return text


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_reasoner(settings: Settings, client: OllamaClient) -> Reasoner:
    if settings.reasoner == "mock":
        return MockReasoner()
    if settings.reasoner in ("gemma", "ollama", "vlm"):
        return GemmaReasoner(client, settings)
    raise ValueError(f"unknown REASONER={settings.reasoner!r}; expected 'gemma' or 'mock'")
