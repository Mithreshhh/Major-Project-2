# on-device-perception-agent

A privacy-preserving browser agent. Perception and redaction happen **on the user's device**
inside a browser extension; only a sanitized, PII-free context is sent to a server-side
vision-language model (VLM) for reasoning; the returned action is executed back in the browser.

> **Status: server reasoning, on-device face detection and pixel redaction are real.**
> The client runs an UltraFace face detector through ONNX Runtime Web and blacks out every face
> before the screenshot leaves the browser; the server reasons with a local Gemma model via
> Ollama. Text/DOM redaction of labels and URLs is still a stub. Search the code for
> `TODO(redaction-dom)`, `TODO(redaction-text)` and `TODO(ui-model)` for the remaining work.

## Architecture

```
┌──────────────────────────── browser (client) ────────────────────────────┐
│                                                                          │
│  content script            background worker                             │
│  ┌───────────────┐   DOM   ┌──────────────────────────────────────────┐  │
│  │ DOM capture   │ ──────▶ │ 1. screenshot (captureVisibleTab)        │  │
│  │ action exec   │ ◀────── │ 2. on-device perception  (ONNX ViT)      │  │
│  └───────────────┘ action  │ 3. redaction (mask sensitive regions)    │  │
│                            │ 4. build SanitizedContext                │  │
│                            └───────────────────┬──────────────────────┘  │
└────────────────────────────────────────────────┼─────────────────────────┘
                                 SanitizedContext │ ▲ ActionCommand
                                   (JSON, HTTPS) ▼ │
                            ┌──────────────────────┴──────────────────────┐
                            │  FastAPI  POST /process                     │
                            │  5. VLM reasoning → next action             │
                            └─────────────────────────────────────────────┘
```

1. **Capture.** The content script summarises visible UI elements (role, label, bounding box,
   whitelisted attributes; never form values). The background worker screenshots the tab
   (`sendScreenshot` in `extension/src/shared/config.ts` turns this off entirely).
2. **Perceive.** An UltraFace face detector runs via ONNX Runtime Web inside the extension and
   reports face boxes as sensitive regions. Visual UI-element detection is a placeholder.
3. **Redact.** Every detected region is blacked out, with a 15% margin, on a fresh copy of the
   screenshot; the raw buffer is zeroed. A failure anywhere in detect-or-redact aborts the step,
   so raw pixels never leave. Text/DOM redaction of labels is still a stub. The client is the
   trust boundary.
4. **Reason.** The `SanitizedContext` is POSTed to the server, which returns one `ActionCommand`
   such as `{"action": "click", "target": "el_1"}`.
5. **Act.** The content script executes the command (click, type, scroll, navigate, ...).

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| [`extension/`](extension/) | Manifest V3 extension (Chrome + Firefox): content script, background worker, build tooling | TypeScript, esbuild |
| [`perception/`](perception/) | On-device ML: UltraFace face detection via ONNX Runtime Web (`inference.ts`), redaction stubs (`redaction.ts`) | TypeScript, onnxruntime-web |
| [`server/`](server/) | Reasoning backend: `POST /process` prompts a local Gemma model through Ollama; `GET /health/gemma` diagnoses it | Python, FastAPI, Pydantic, httpx |
| [`shared/`](shared/) | Data contract: TypeScript types + JSON Schemas for `SanitizedContext` and `ActionCommand` | TypeScript, JSON Schema |

The root `package.json` is an npm workspace managing `shared`, `perception`, and `extension`.
The server is a plain Python project with its own virtualenv.

## Prerequisites

- Node.js 20+ and npm 9+
- Python 3.11+
- Chrome 120+ and/or Firefox 128+
- [Ollama](https://ollama.com) with the model `ledgerguard-gemma4-e2b-q4-0:latest` available
  (`ollama list` should show it). Another tag can be used via `OLLAMA_MODEL`.

## Quick start

### 1. Install and build the extension

```bash
npm install          # installs all workspaces
npm run typecheck    # tsc across shared, perception, extension
npm test             # perception: real face detection over sample images; extension: bundle smoke tests
npm run build        # -> extension/dist/chrome and extension/dist/firefox (models and ORT wasm included)
```

`npm run dev` rebuilds on change (reload the extension in the browser to pick it up).

### 2. Load the extension in developer mode

**Chrome / Edge / Brave**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `extension/dist/chrome`.
4. Open the service-worker console via the **Service worker** link on the extension card to see logs.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and choose `extension/dist/firefox/manifest.json`.
3. Firefox MV3 treats host permissions as optional: open the add-on's **Permissions** tab in
   `about:addons` and enable access to `localhost` / `127.0.0.1`, or the server call will be blocked.
4. Click **Inspect** on the add-on card to see background logs.

### 3. Start the FastAPI server

```bash
cd server
python -m venv .venv
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS / Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Check it: <http://127.0.0.1:8000/health> should return
`{"status":"ok","protocolVersion":"0.1.0","reasoner":"gemma","model":"ledgerguard-gemma4-e2b-q4-0:latest"}`.
Then <http://127.0.0.1:8000/health/gemma?warm=true> confirms Ollama is reachable, the model tag
exists, and loads it into memory. Interactive docs live at <http://127.0.0.1:8000/docs>.

Configuration is by environment variable (`REASONER`, `OLLAMA_URL`, `OLLAMA_MODEL`, timeouts,
element cap). See `server/.env.example`. `REASONER=mock` restores the deterministic stand-in.

Run the tests:

```bash
pytest -q                                                          # unit tests, no Ollama needed
$env:RUN_GEMMA_INTEGRATION = "1"; pytest tests/integration -q -s   # one live Gemma round-trip (PowerShell)
```

From the repo root, `npm run server:install`, `npm run server:dev`, `npm run server:test` and
`npm run server:test:gemma` wrap the same commands (Windows paths).

### 4. Run one agent step

1. With the server running and the extension loaded, open any `http(s)` page.
2. Click the extension's toolbar icon. One step runs: capture → perceive → redact → `/process` → execute.
3. Watch the background console. Gemma picks one action from the element list; the first call
   also loads the model, so allow around ten seconds for it.

Optional settings via the extension's storage (e.g. from the service-worker console):

```js
chrome.storage.local.set({ task: "Submit the contact form", serverUrl: "http://127.0.0.1:8000" });
```

## Data contract

Defined once in [`shared/`](shared/) and mirrored in `server/app/schemas.py`.

- **Request** `SanitizedContext`: protocol version, session/step ids, the user's task, page and
  viewport metadata, a list of sanitized `UIElement`s, an optional redacted screenshot, the list
  of `RedactedRegion`s that were masked, and the action history.
- **Response** `ActionCommand`: a discriminated union on `action` —
  `click`, `type`, `scroll`, `navigate`, `wait`, `done`, `ask_user`, `noop` — plus optional
  `reasoning` and `confidence`.

Canonical examples are in `shared/examples/`. The server test-suite validates them against both
the JSON Schemas and the Pydantic models, so the two sides can be developed independently.

## Where the real work goes (next steps)

| Marker | File | Work |
| --- | --- | --- |
| `TODO(redaction-dom)`, `TODO(redaction-text)` | `perception/src/redaction.ts`, `extension/src/content/index.ts` | Flag password/payment/contact fields from the DOM, mask PII in labels and attributes, scrub URLs. Pixel masking of detected faces is done |
| `TODO(ui-model)` | `perception/src/inference.ts` | Fine-tuned visual UI-element detector to fill the `uiElements` placeholder |
| `TODO(agent)` | `extension/src/content/index.ts` | Confirmation UI for destructive actions, target highlighting, multi-step loop |

Server-side reasoning is implemented in `server/app/prompting.py` and `server/app/reasoning.py`
(Gemma via Ollama, JSON-mode prompt, lenient parser, one retry). Prompt tuning and a
vision-capable model are the natural follow-ups there.

## Security note

Faces in the screenshot are blacked out on-device before anything is sent, and `npm test` in
`extension/` runs the built worker with the real model to check that the pixels reaching the
server are masked exactly where the detector fired and untouched elsewhere. Everything else is
forwarded as captured: text in the screenshot, and the DOM summary (labels, placeholders, page
URL and title). Until `TODO(redaction-text)` and `TODO(redaction-dom)` are done, only run
against local or non-sensitive pages, and keep the server on `localhost`.

## License

MIT
