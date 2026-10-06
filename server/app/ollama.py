"""
Minimal async client for the Ollama HTTP API. Only the calls the reasoner and the health
endpoint need: /api/version, /api/tags, /api/ps, /api/show, /api/generate (warm-up), /api/chat.

Errors are mapped onto a small exception hierarchy so the FastAPI layer can turn them into
precise HTTP responses instead of a generic 500.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

log = logging.getLogger("odpa.ollama")


class OllamaError(Exception):
    """Anything that went wrong talking to Ollama."""


class OllamaUnavailableError(OllamaError):
    """Ollama is not reachable (connection refused, DNS failure, timeout)."""


class OllamaModelNotFoundError(OllamaError):
    """The configured model tag does not exist on the Ollama server."""


class OllamaResponseError(OllamaError):
    """Ollama answered, but with an HTTP error or a body we cannot use."""


def normalise_tag(name: str) -> str:
    """`foo` and `foo:latest` name the same model."""
    last = name.rsplit("/", 1)[-1]
    return name if ":" in last else f"{name}:latest"


@dataclass
class ModelInfo:
    name: str
    capabilities: list[str] = field(default_factory=list)
    family: str = ""
    parameter_size: str = ""
    quantization: str = ""
    context_length: Optional[int] = None

    @property
    def supports_vision(self) -> bool:
        return "vision" in self.capabilities

    @property
    def supports_thinking(self) -> bool:
        return "thinking" in self.capabilities


def _error_detail(res: httpx.Response) -> str:
    try:
        body = res.json()
        if isinstance(body, dict) and isinstance(body.get("error"), str):
            return body["error"]
    except ValueError:
        pass
    return res.text[:300]


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout_s: float = 120.0,
        keep_alive: str = "10m",
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.keep_alive = keep_alive
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_s, connect=5.0),
            transport=transport,
        )
        self._info: Optional[ModelInfo] = None

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------ plumbing

    async def _request(self, method: str, path: str, json: Any = None) -> Any:
        try:
            res = await self._http.request(method, path, json=json)
        except httpx.TimeoutException as exc:
            raise OllamaUnavailableError(f"timed out waiting for Ollama at {self.base_url}{path}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise OllamaUnavailableError(f"cannot reach Ollama at {self.base_url}: {exc}") from exc

        if res.status_code >= 400:
            detail = _error_detail(res)
            if res.status_code == 404 and "not found" in detail.lower():
                raise OllamaModelNotFoundError(
                    f"model '{self.model}' is not available on Ollama at {self.base_url}: {detail}"
                )
            raise OllamaResponseError(f"Ollama {method} {path} failed with HTTP {res.status_code}: {detail}")

        try:
            return res.json()
        except ValueError as exc:
            raise OllamaResponseError(f"Ollama {method} {path} returned a non-JSON body") from exc

    # ------------------------------------------------------------------ diagnostics

    async def version(self) -> str:
        data = await self._request("GET", "/api/version")
        return str(data.get("version", "unknown"))

    async def list_models(self) -> list[str]:
        data = await self._request("GET", "/api/tags")
        return [m.get("name") or m.get("model") for m in data.get("models", []) if m.get("name") or m.get("model")]

    async def running_models(self) -> list[str]:
        data = await self._request("GET", "/api/ps")
        return [m.get("name") or m.get("model") for m in data.get("models", []) if m.get("name") or m.get("model")]

    async def model_info(self, refresh: bool = False) -> ModelInfo:
        """Capabilities and details for the configured model (cached after the first call)."""
        if self._info is not None and not refresh:
            return self._info
        data = await self._request("POST", "/api/show", json={"model": self.model})
        details = data.get("details") or {}
        model_info = data.get("model_info") or {}
        context_length = next(
            (v for k, v in model_info.items() if k.endswith(".context_length") and isinstance(v, int)), None
        )
        self._info = ModelInfo(
            name=self.model,
            capabilities=[str(c) for c in (data.get("capabilities") or [])],
            family=str(details.get("family", "")),
            parameter_size=str(details.get("parameter_size", "")),
            quantization=str(details.get("quantization_level", "")),
            context_length=context_length,
        )
        return self._info

    async def warm(self, num_ctx: Optional[int] = None) -> None:
        """
        Load the model into memory without generating anything (empty-prompt generate).

        Pass the same `num_ctx` the real requests use: Ollama reloads the whole model when the
        context size changes, so warming with the default would be wasted (and the first real
        request would pay for a second load).
        """
        payload: dict[str, Any] = {"model": self.model, "keep_alive": self.keep_alive}
        if num_ctx:
            payload["options"] = {"num_ctx": num_ctx}
        await self._request("POST", "/api/generate", json=payload)

    # ------------------------------------------------------------------ inference

    async def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        json_mode: bool = True,
        think: Optional[bool] = None,
        options: Optional[dict[str, Any]] = None,
    ) -> str:
        """Non-streaming chat completion. Returns the assistant message content."""
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "keep_alive": self.keep_alive,
        }
        if json_mode:
            payload["format"] = "json"
        if think is not None:
            payload["think"] = think
        if options:
            payload["options"] = options

        data = await self._request("POST", "/api/chat", json=payload)
        message = data.get("message") or {}
        content = message.get("content")
        if not isinstance(content, str):
            raise OllamaResponseError("Ollama /api/chat response has no message.content")

        log.debug(
            "ollama chat done_reason=%s prompt_tokens=%s eval_tokens=%s total_ms=%s",
            data.get("done_reason"),
            data.get("prompt_eval_count"),
            data.get("eval_count"),
            (data.get("total_duration") or 0) // 1_000_000,
        )
        return content
