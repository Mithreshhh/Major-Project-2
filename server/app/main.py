"""
FastAPI application hosting the server-side reasoning component.

Endpoints
  GET  /health   liveness + protocol version + active reasoner
  POST /process  SanitizedContext -> ActionCommand

Run locally:  uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .reasoning import Reasoner, get_reasoner
from .schemas import PROTOCOL_VERSION, ActionCommand, HealthResponse, SanitizedContext

log = logging.getLogger("odpa.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.reasoner = get_reasoner()
    log.info("reasoner=%s protocol=%s", app.state.reasoner.name, PROTOCOL_VERSION)
    yield


app = FastAPI(
    title="On-Device Perception Agent - Reasoning Server",
    version=PROTOCOL_VERSION,
    lifespan=lifespan,
)

# Extension pages fetch with host_permissions, so CORS is mostly a convenience for local tooling.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome|moz)-extension://.*$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


def _reasoner() -> Reasoner:
    return app.state.reasoner


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(reasoner=_reasoner().name)


@app.post("/process", response_model=ActionCommand)
async def process(context: SanitizedContext) -> ActionCommand:
    """
    Accept a sanitized context from the extension and return the next action.

    The payload is assumed to be already redacted on-device; the server never receives raw
    screenshots or PII. Nothing is persisted here.
    """
    if context.protocolVersion.split(".")[0] != PROTOCOL_VERSION.split(".")[0]:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported protocolVersion {context.protocolVersion}; server speaks {PROTOCOL_VERSION}",
        )

    log.info(
        "process session=%s step=%d elements=%d redactions=%d screenshot=%s",
        context.sessionId,
        context.stepIndex,
        len(context.elements),
        len(context.redactions),
        "yes" if context.screenshot else "no",
    )

    try:
        return await _reasoner().decide(context)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
