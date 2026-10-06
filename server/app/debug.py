"""
"What the AI sees": a record of the sanitized payloads /process received.

Everything here is data the server was already sent. It never holds anything the client did not
choose to send, so it is a faithful view of what crosses the trust boundary. Useful to prove
redaction works: open GET /debug/view next to the real page.

Captures are kept in memory (last N) and, if ODPA_DEBUG_SAVE_DIR is set, written to disk as
<n>.jpg + <n>.json for later inspection. Disable everything with ODPA_DEBUG_VIEW=0.
"""
from __future__ import annotations

import base64
import binascii
import itertools
import json
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import HTMLResponse

from .schemas import SanitizedContext

log = logging.getLogger("odpa.debug")

#: The "What the AI sees" page (plain HTML, CSS and JS; no build step, no external assets).
VIEW_PATH = Path(__file__).with_name("debug_view.html")


@dataclass
class Capture:
    id: int
    received_at: float
    task: str
    session_id: str
    step_index: int
    url: str
    title: str
    viewport: dict[str, float]
    elements: list[dict[str, Any]]
    redactions: list[dict[str, Any]]
    perception: dict[str, Any]
    screenshot_mime: Optional[str]
    screenshot_bytes: Optional[bytes] = field(repr=False, default=None)
    screenshot_size: Optional[tuple[int, int]] = None
    command: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    reasoning_ms: Optional[int] = None
    page_text: Optional[str] = None
    profile_fields: Optional[list[dict[str, str]]] = None

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "receivedAt": self.received_at,
            "task": self.task,
            "sessionId": self.session_id,
            "stepIndex": self.step_index,
            "url": self.url,
            "title": self.title,
            "viewport": self.viewport,
            "elements": self.elements,
            "redactions": self.redactions,
            "perception": self.perception,
            "hasScreenshot": self.screenshot_bytes is not None,
            "screenshotMime": self.screenshot_mime,
            "screenshotSize": list(self.screenshot_size) if self.screenshot_size else None,
            "command": self.command,
            "error": self.error,
            "reasoningMs": self.reasoning_ms,
            "pageText": self.page_text,
            "profileFields": self.profile_fields,
        }


class CaptureStore:
    def __init__(self, limit: int = 30, save_dir: Optional[Path] = None) -> None:
        self._items: deque[Capture] = deque(maxlen=limit)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self.save_dir = save_dir
        if save_dir:
            save_dir.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        context: SanitizedContext,
        *,
        command: Optional[dict[str, Any]] = None,
        error: Optional[str] = None,
        reasoning_ms: Optional[int] = None,
    ) -> Capture:
        shot = context.screenshot
        image: Optional[bytes] = None
        if shot is not None:
            try:
                image = base64.b64decode(shot.dataBase64, validate=True)
            except (binascii.Error, ValueError):
                image = None

        with self._lock:
            capture = Capture(
                id=next(self._ids),
                received_at=time.time(),
                task=context.task,
                session_id=context.sessionId,
                step_index=context.stepIndex,
                url=context.page.url,
                title=context.page.title,
                viewport=context.viewport.model_dump(),
                elements=[e.model_dump(exclude_none=True) for e in context.elements],
                redactions=[r.model_dump() for r in context.redactions],
                perception=context.perception.model_dump(exclude_none=True),
                screenshot_mime=shot.mimeType if shot else None,
                screenshot_bytes=image,
                screenshot_size=(shot.width, shot.height) if shot else None,
                command=command,
                error=error,
                reasoning_ms=reasoning_ms,
                page_text=context.pageText,
                profile_fields=[f.model_dump() for f in context.profileFields] if context.profileFields else None,
            )
            self._items.append(capture)

        if self.save_dir:
            try:
                stem = self.save_dir / f"{capture.id:04d}"
                if image is not None:
                    ext = {"image/png": ".png", "image/webp": ".webp"}.get(capture.screenshot_mime or "", ".jpg")
                    stem.with_suffix(ext).write_bytes(image)
                stem.with_suffix(".json").write_text(json.dumps(capture.summary(), indent=2), encoding="utf-8")
            except OSError as exc:  # never let debugging break /process
                log.warning("could not save capture %s: %s", capture.id, exc)
        return capture

    def list(self) -> list[Capture]:
        with self._lock:
            return list(self._items)

    def get(self, capture_id: int) -> Optional[Capture]:
        with self._lock:
            return next((c for c in self._items if c.id == capture_id), None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def build_router(store: CaptureStore) -> APIRouter:
    router = APIRouter(prefix="/debug", tags=["debug"])

    @router.get("/captures")
    async def captures() -> dict[str, Any]:
        items = store.list()
        return {"count": len(items), "captures": [c.summary() for c in reversed(items)]}

    @router.get("/captures/{capture_id}/screenshot")
    async def screenshot(capture_id: int) -> Response:
        capture = store.get(capture_id)
        if capture is None or capture.screenshot_bytes is None:
            raise HTTPException(status_code=404, detail="no screenshot for that capture")
        return Response(
            content=capture.screenshot_bytes,
            media_type=capture.screenshot_mime or "image/jpeg",
            headers={"cache-control": "no-store"},
        )

    @router.delete("/captures")
    async def clear() -> dict[str, bool]:
        store.clear()
        return {"ok": True}

    @router.get("/view", response_class=HTMLResponse)
    async def view() -> HTMLResponse:
        # Read per request: the page can be edited without restarting the server.
        return HTMLResponse(VIEW_PATH.read_text(encoding="utf-8"), headers={"cache-control": "no-store"})

    return router
