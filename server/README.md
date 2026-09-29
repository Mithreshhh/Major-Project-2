# server

FastAPI backend hosting the server-side reasoning component. `/process` prompts a local Gemma
model through Ollama and returns one `ActionCommand`.

## Run

```bash
cd server
python -m venv .venv
.venv\Scripts\activate          # Windows   (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Ollama must be running with the model present:

```bash
ollama serve                      # if it is not already running as a service
ollama list                       # should include ledgerguard-gemma4-e2b-q4-0:latest
curl http://127.0.0.1:8000/health/gemma?warm=true
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness, protocol version, active reasoner and model |
| `GET /health/gemma` | Ollama reachable? model tag present? model loaded? `?warm=true` loads it. 503 with the same body when not usable |
| `POST /process` | `SanitizedContext` in, `ActionCommand` out |
| `POST /ask` | `SanitizedContext` with `pageText` in, `{ "answer": "..." }` out. Read-only: returns text, never an action |
| `GET /debug/view` | "What the AI sees": every sanitized payload received, with redaction outlines and Gemma's decision. JSON at `/debug/captures`. `ODPA_DEBUG_VIEW=0` disables it |

Error responses from `/process`:

| Status | Meaning |
| --- | --- |
| 400 | Protocol major version mismatch |
| 422 | Payload does not match the shared contract |
| 502 | Model answered twice without producing a valid command. Body carries both raw attempts |
| 503 | Ollama unreachable or the model tag is missing. Body carries a hint |

## Files

| Path | Purpose |
| --- | --- |
| `app/main.py` | FastAPI app, routes, error mapping |
| `app/settings.py` | Environment-driven configuration (see `.env.example`) |
| `app/ollama.py` | Small async Ollama client with typed errors |
| `app/prompting.py` | Prompt construction and the forgiving output parser |
| `app/reasoning.py` | `GemmaReasoner` (default) and `MockReasoner` (`REASONER=mock`) |
| `app/schemas.py` | Pydantic mirror of `/shared` |
| `tests/` | Fast unit tests, no Ollama needed |
| `tests/integration/` | One live round-trip, skipped by default |

## How a decision is made

1. Capabilities of the configured model are fetched once from `/api/show`. The screenshot is
   attached only if the model advertises `vision` (override with `GEMMA_SEND_SCREENSHOT`), and
   thinking is switched off for models that support it.
2. The prompt lists the task, page, previous actions, and up to `GEMMA_MAX_ELEMENTS` UI elements
   as `id | role | label | location`, where location is a 3x3 grid word plus x, y, w, h.
3. Ollama is called in JSON mode at temperature 0.
4. The reply is parsed leniently (code fences, surrounding prose, alias keys such as
   `element_id`, alias actions such as `press`, numeric or label targets) and validated against
   the contract. Targets must be real element ids.
5. If parsing fails, the bad reply and the error go back to the model once. A second failure
   returns 502 with both raw attempts.

## Tests

```bash
pytest -q                                   # unit tests only, milliseconds, no Ollama
$env:RUN_GEMMA_INTEGRATION = "1"; pytest tests/integration -q -s   # PowerShell, live model
RUN_GEMMA_INTEGRATION=1 pytest tests/integration -q -s             # bash, live model
```
