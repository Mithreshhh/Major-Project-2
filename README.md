# on-device-perception-agent

A privacy-preserving browser agent. Perception and redaction happen **on the user's device**
inside a browser extension; only a sanitized, PII-free context is sent to a server-side
vision-language model (VLM) for reasoning; the returned action is executed back in the browser.

> **Status: scaffolding.** The end-to-end loop runs with a placeholder perception model, a
> pass-through redaction layer, and a mock reasoner. Search the code for `TODO(model)`,
> `TODO(redaction)`, and `TODO(vlm)` to find where the real work goes.

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
   whitelisted attributes; never form values). The background worker screenshots the tab.
2. **Perceive.** A lightweight ViT runs via ONNX Runtime Web inside the extension.
3. **Redact.** DOM heuristics, text heuristics and model detections mark sensitive regions,
   which are masked in the pixels and the DOM summary. The client is the trust boundary.
4. **Reason.** The `SanitizedContext` is POSTed to the server, which returns one `ActionCommand`
   such as `{"action": "click", "target": "el_1"}`.
5. **Act.** The content script executes the command (click, type, scroll, navigate, ...).

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| [`extension/`](extension/) | Manifest V3 extension (Chrome + Firefox): content script, background worker, build tooling | TypeScript, esbuild |
| [`perception/`](perception/) | On-device ML: ONNX Runtime Web integration (`inference.ts`) and redaction stubs (`redaction.ts`) | TypeScript, onnxruntime-web |
| [`server/`](server/) | Reasoning backend: `POST /process` with a mock reasoner and a `VLMReasoner` stub | Python, FastAPI, Pydantic |
| [`shared/`](shared/) | Data contract: TypeScript types + JSON Schemas for `SanitizedContext` and `ActionCommand` | TypeScript, JSON Schema |

The root `package.json` is an npm workspace managing `shared`, `perception`, and `extension`.
The server is a plain Python project with its own virtualenv.

## Prerequisites

- Node.js 20+ and npm 9+
- Python 3.11+
- Chrome 120+ and/or Firefox 128+

## Quick start

### 1. Install and build the extension

```bash
npm install          # installs all workspaces
npm run typecheck    # tsc across shared, perception, extension
npm run build        # -> extension/dist/chrome and extension/dist/firefox
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

Check it: <http://127.0.0.1:8000/health> should return `{"status":"ok","protocolVersion":"0.1.0","reasoner":"mock"}`.
Interactive docs live at <http://127.0.0.1:8000/docs>.

Run the tests (contract tests against `shared/schema` plus endpoint tests):

```bash
pytest -q
```

From the repo root, `npm run server:install`, `npm run server:dev` and `npm run server:test`
wrap the same commands (Windows paths).

### 4. Run one agent step

1. With the server running and the extension loaded, open any `http(s)` page.
2. Click the extension's toolbar icon. One step runs: capture → perceive → redact → `/process` → execute.
3. Watch the background console. The mock reasoner clicks the first visible button
   (preferring one labelled "Submit") or returns `noop`.

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
| `TODO(model)` | `perception/src/inference.ts`, `extension/src/shared/config.ts` | Export a lightweight ViT to ONNX, place it in `extension/public/models/`, implement `preprocess`/`postprocess`, enable `InferenceSession.create` |
| `TODO(redaction)` | `perception/src/redaction.ts`, `extension/src/content/index.ts` | DOM + text + ML detectors, in-place pixel masking, label masking, URL scrubbing |
| `TODO(vlm)` | `server/app/reasoning.py` | Prompt construction, VLM call, output parsing/validation in `VLMReasoner` |
| `TODO(agent)` | `extension/src/content/index.ts` | Confirmation UI for destructive actions, target highlighting, multi-step loop |

## Security note

Until `TODO(redaction)` is implemented **nothing is actually redacted**; the pipeline forwards
the DOM summary and screenshot as captured. Only run against local or non-sensitive pages, and
keep the server on `localhost`.

## License

MIT
