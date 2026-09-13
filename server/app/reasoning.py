"""
Server-side reasoning: SanitizedContext -> ActionCommand.

Status: SCAFFOLD. `MockReasoner` returns canned commands so the extension can be developed
end-to-end. `VLMReasoner` is where the real vision-language model goes (see TODO(vlm)).
"""
from __future__ import annotations

import os
from typing import Protocol

from .schemas import (
    ActionCommand,
    ClickAction,
    DoneAction,
    NoopAction,
    SanitizedContext,
)


class Reasoner(Protocol):
    name: str

    async def decide(self, context: SanitizedContext) -> ActionCommand: ...


class MockReasoner:
    """
    Deterministic stand-in for the VLM.

    Picks the first visible, interactive button (preferring one labelled "submit"), otherwise
    reports that there is nothing to do. Purely to give the client something plausible to execute.
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


class VLMReasoner:
    """
    Real vision-language-model reasoner.

    TODO(vlm): implement
      1. Decode `context.screenshot` (base64 -> PIL image) if present.
      2. Build a prompt from `context.task`, `context.history`, and a compact rendering of
         `context.elements` (id, role, label, bbox) plus `context.redactions` so the model knows
         which regions were hidden.
      3. Call the VLM (hosted API or local model) with image + prompt.
      4. Parse the model output into an ActionCommand and validate it with pydantic; on parse
         failure return NoopAction with the error in `reasoning` instead of raising.
      5. Ensure any `target` refers to an id present in `context.elements`.
    """

    name = "vlm"

    async def decide(self, context: SanitizedContext) -> ActionCommand:
        raise NotImplementedError("VLMReasoner is not implemented yet (see TODO(vlm)).")


def get_reasoner() -> Reasoner:
    """Select the reasoner from the REASONER env var (default: mock)."""
    kind = os.getenv("REASONER", "mock").lower()
    if kind == "vlm":
        return VLMReasoner()
    return MockReasoner()
