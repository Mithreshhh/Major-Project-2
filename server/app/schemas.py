"""
Pydantic mirror of the data contract in /shared.

Source of truth: shared/src/types.ts and shared/schema/*.schema.json.
Keep these models in lock-step with them; tests/test_contract.py checks that the shared example
payloads are accepted here AND validate against the JSON Schemas.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

#: Mirrors shared/src/constants.ts. Bump both on breaking changes.
PROTOCOL_VERSION = "0.1.0"


class _Strict(BaseModel):
    """Reject unknown fields so contract drift fails loudly."""

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Request: SanitizedContext
# ---------------------------------------------------------------------------


class BoundingBox(_Strict):
    x: float
    y: float
    width: float = Field(ge=0)
    height: float = Field(ge=0)


class Viewport(_Strict):
    width: float = Field(ge=0)
    height: float = Field(ge=0)
    scrollX: float
    scrollY: float
    devicePixelRatio: float = Field(gt=0)


class PageMeta(_Strict):
    url: str
    title: str
    capturedAt: str


ElementRole = Literal[
    "button", "link", "textbox", "checkbox", "radio", "select",
    "option", "image", "heading", "text", "other",
]


class UIElement(_Strict):
    id: str = Field(min_length=1)
    role: ElementRole
    label: str
    bbox: BoundingBox
    attributes: Optional[dict[str, str]] = None
    isVisible: bool
    isInteractive: bool
    redacted: Optional[bool] = None


SensitiveCategory = Literal[
    "pii_text", "credential", "payment_card", "face", "address", "email", "phone", "other"
]


class RedactedRegion(_Strict):
    bbox: BoundingBox
    category: SensitiveCategory
    confidence: float = Field(ge=0, le=1)
    method: Literal["ml", "heuristic", "dom"]


class SanitizedScreenshot(_Strict):
    mimeType: Literal["image/png", "image/jpeg", "image/webp"]
    dataBase64: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class PerceptionSummary(_Strict):
    modelId: str
    latencyMs: float = Field(ge=0)
    embedding: Optional[list[float]] = None


# ---------------------------------------------------------------------------
# Response: ActionCommand (discriminated union on `action`)
# ---------------------------------------------------------------------------


class _ActionBase(_Strict):
    reasoning: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0, le=1)


class ClickAction(_ActionBase):
    action: Literal["click"]
    target: str = Field(min_length=1)


class TypeAction(_ActionBase):
    action: Literal["type"]
    target: str = Field(min_length=1)
    text: str
    submit: Optional[bool] = None


class ScrollAction(_ActionBase):
    action: Literal["scroll"]
    direction: Literal["up", "down"]
    amountPx: Optional[float] = Field(default=None, ge=0)


class NavigateAction(_ActionBase):
    action: Literal["navigate"]
    url: str


class WaitAction(_ActionBase):
    action: Literal["wait"]
    ms: int = Field(ge=0)


class DoneAction(_ActionBase):
    action: Literal["done"]
    summary: str


class AskUserAction(_ActionBase):
    action: Literal["ask_user"]
    question: str


class NoopAction(_ActionBase):
    action: Literal["noop"]
    reason: str


ActionCommand = Annotated[
    Union[
        ClickAction,
        TypeAction,
        ScrollAction,
        NavigateAction,
        WaitAction,
        DoneAction,
        AskUserAction,
        NoopAction,
    ],
    Field(discriminator="action"),
]


class SanitizedContext(_Strict):
    protocolVersion: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    sessionId: str = Field(min_length=1)
    stepIndex: int = Field(ge=0)
    task: str
    page: PageMeta
    viewport: Viewport
    elements: list[UIElement]
    screenshot: Optional[SanitizedScreenshot]
    redactions: list[RedactedRegion]
    history: list[ActionCommand]
    perception: PerceptionSummary


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


class HealthResponse(_Strict):
    status: Literal["ok"] = "ok"
    protocolVersion: str = PROTOCOL_VERSION
    reasoner: str
