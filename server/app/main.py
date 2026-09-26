"""
FastAPI application hosting the server-side reasoning component.

Endpoints
  GET  /health        liveness + protocol version + active reasoner
  GET  /health/gemma  is Ollama reachable, is the model present, is it loaded (add ?warm=true to load it)
  POST /process       SanitizedContext -> ActionCommand

Run locally:  uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .ollama import (
    OllamaClient,
    OllamaError,
    OllamaModelNotFoundError,
    OllamaResponseError,
    OllamaUnavailableError,
    normalise_tag,
)
from .reasoning import Reasoner, ReasonerError, build_reasoner
from .schemas import PROTOCOL_VERSION, ActionCommand, GemmaHealth, HealthResponse, SanitizedContext
from .settings import get_settings

log = logging.getLogger("odpa.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    client = OllamaClient(
        settings.ollama_url,
        settings.ollama_model,
        timeout_s=settings.ollama_timeout_s,
        keep_alive=settings.ollama_keep_alive,
    )
    app.state.settings = settings
    app.state.ollama = client
    app.state.reasoner = build_reasoner(settings, client)
    log.info(
        "reasoner=%s model=%s ollama=%s protocol=%s",
        app.state.reasoner.name,
        settings.ollama_model,
        settings.ollama_url,
        PROTOCOL_VERSION,
    )
    try:
        yield
    finally:
        await client.aclose()


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


def _ollama() -> OllamaClient:
    return app.state.ollama


# ---------------------------------------------------------------------------
# Error mapping: never a bare 500 for a predictable failure
# ---------------------------------------------------------------------------


@app.exception_handler(OllamaUnavailableError)
async def _ollama_unavailable(_: Request, exc: OllamaUnavailableError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc), "hint": "Is Ollama running? Check GET /health/gemma and OLLAMA_URL."},
    )


@app.exception_handler(OllamaModelNotFoundError)
async def _ollama_model_missing(_: Request, exc: OllamaModelNotFoundError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc), "hint": "Run `ollama list` and set OLLAMA_MODEL to an existing tag."},
    )


@app.exception_handler(OllamaResponseError)
async def _ollama_bad_response(_: Request, exc: OllamaResponseError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(ReasonerError)
async def _reasoner_error(_: Request, exc: ReasonerError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "attempts": exc.attempts},
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
async def health() -> HealthResponse:
    reasoner = _reasoner()
    model = _ollama().model if reasoner.name == "gemma" else None
    return HealthResponse(reasoner=reasoner.name, model=model)


@app.get("/health/gemma", response_model=GemmaHealth, responses={503: {"model": GemmaHealth}})
async def health_gemma(warm: bool = False):
    """
    Diagnose the Ollama side step by step: server reachable -> model tag present -> model loaded.
    Returns 503 with the same body shape whenever the reasoner could not work right now.
    """
    client = _ollama()
    body = GemmaHealth(
        status="unavailable",
        ollamaUrl=client.base_url,
        model=client.model,
        reachable=False,
        modelAvailable=False,
        modelLoaded=False,
        detail="",
    )

    try:
        body.ollamaVersion = await client.version()
        names = await client.list_models()
    except OllamaError as exc:
        body.detail = f"{exc}. Start Ollama (`ollama serve`) or point OLLAMA_URL at it."
        return JSONResponse(status_code=503, content=body.model_dump())

    body.reachable = True
    wanted = normalise_tag(client.model)
    body.modelAvailable = wanted in {normalise_tag(n) for n in names}
    if not body.modelAvailable:
        body.status = "model_missing"
        body.detail = (
            f"model '{client.model}' is not on this Ollama server. "
            f"Available: {', '.join(names) or 'none'}. Set OLLAMA_MODEL or create/pull the model."
        )
        return JSONResponse(status_code=503, content=body.model_dump())

    try:
        info = await client.model_info(refresh=True)
        body.capabilities = info.capabilities
        if warm:
            await client.warm()
        running = await client.running_models()
    except OllamaError as exc:
        body.detail = str(exc)
        return JSONResponse(status_code=503, content=body.model_dump())

    body.modelLoaded = wanted in {normalise_tag(n) for n in running}
    body.status = "ok"
    body.detail = (
        "model loaded and ready"
        if body.modelLoaded
        else "model available but not loaded in memory yet; the first /process call will load it, "
        "or call GET /health/gemma?warm=true"
    )
    return body


@app.post("/process", response_model=ActionCommand, response_model_exclude_none=True)
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
    return await _reasoner().decide(context)
