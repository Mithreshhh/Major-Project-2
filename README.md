# on-device-perception-agent

A privacy-preserving browser agent. You type a task in plain English; the extension looks at the
page, **hides faces, passwords and personal data on your device**, and sends only that sanitized
view to a local Gemma model, which decides the next action. The extension carries it out and
repeats until the task is done.

> **Status.** Working end to end in real Chrome (see `e2e/proof/`): on-device face detection with
> UltraFace on ONNX Runtime Web, redaction of faces, password/card fields and PII text, an
> on-device UI detector we trained (YOLO11n) that finds buttons, inputs and links from the
> screenshot, multi-step tasks driven by Gemma via Ollama, a compression study of the face model,
> and a server page that shows exactly what the AI received. The agent still acts on DOM
> elements; merging vision-only elements in is next. See [Next steps](#next-steps).

For presenting it, see **[DEMO.md](DEMO.md)**.

## Architecture

```
┌──────────────────────────── browser (client, trust boundary) ──────────────────────────────┐
│                                                                                            │
│  popup              content script                   background worker                     │
│  ┌──────────┐ task  ┌──────────────────────┐  DOM +  ┌───────────────────────────────────┐ │
│  │ Run task ├──────▶│ UI elements (DOM)    │  PII    │ 1. screenshot (captureVisibleTab) │ │
│  │ progress │◀──────│ PII boxes in text    ├────────▶│ 2. face detection (UltraFace/ONNX)│ │
│  └──────────┘       │ executes actions     │◀────────┤ 3. black out faces, sensitive     │ │
│                     └──────────────────────┘ action  │    fields, PII text; scrub labels │ │
│                                                      │ 4. build SanitizedContext         │ │
│                                                      └──────────────┬────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┼──────────────────────┘
                                          SanitizedContext (JSON)     │   ▲ ActionCommand
                                                                      ▼   │
                                          ┌───────────────────────────────┴───────────────┐
                                          │ FastAPI  POST /process → Gemma (Ollama)       │
                                          │ GET /debug/view  "What the AI sees"           │
                                          └───────────────────────────────────────────────┘
```

1. **Capture.** The content script lists visible UI elements (role, label, box; never form
   values) and finds PII in visible text and typed values, returning only bounding boxes. The
   background worker screenshots the tab.
2. **Perceive.** UltraFace (RFB-640, cleaned graph) runs on ONNX Runtime Web inside the
   extension and returns face boxes, ~100-130 ms per screenshot in Chrome. Our UI detector
   (YOLO11n, trained on auto-labelled pages) finds buttons, inputs and links from the same
   pixels, ~0.4-0.8 s, and is scored against the DOM on every step.
3. **Redact.** Faces (model), every photo, video and canvas in view (DOM, so tiny avatars are
   covered too), password/PIN/card fields (DOM rules) and emails, phones, card,
   Aadhaar, PAN and SSN numbers (text rules) are blacked out on a fresh copy of the screenshot;
   the raw buffer is zeroed. PII in labels, the page title and the URL becomes `[REDACTED]`.
   If detection or redaction fails, the step aborts: raw pixels never leave.
4. **Reason.** The sanitized context goes to the server; Gemma returns one action such as
   `{"action": "type", "target": "el_7", "text": "john@example.com"}`.
5. **Act.** The content script executes it; the worker loops until Gemma says `done` or
   `ask_user`, the same action repeats, or 10 steps pass.

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| [`extension/`](extension/) | MV3 extension (Chrome + Firefox): popup, content script, background worker, build | TypeScript, esbuild |
| [`perception/`](perception/) | Face detection, UI detection, PII detection, redaction, compression study, UI-detector training | TypeScript, onnxruntime-web; Python for training and quantization |
| [`server/`](server/) | `POST /process` and `POST /ask` (Gemma via Ollama), `/health/gemma`, `/debug/view` | Python, FastAPI |
| [`shared/`](shared/) | Data contract: TypeScript types + JSON Schemas | TypeScript, JSON Schema |
| [`e2e/`](e2e/) | Real-browser run of the whole system, saves proof screenshots | Puppeteer |
| [`demo/`](demo/) | Test pages: a product site with a contact form and sample PII, a job application, a bank login page, an Instagram-style chat | HTML |

## Prerequisites

- Node.js 20+, Python 3.11+, Chrome 120+ (or Firefox 128+)
- [Ollama](https://ollama.com) with `ledgerguard-gemma4-e2b-q4-0:latest` (`ollama list`), or set `OLLAMA_MODEL`

## Quick start

```bash
npm start            # or double-click start.bat on Windows
```

That one command checks Ollama (starting it if needed), creates the server's Python environment
and installs npm packages on the first run, rebuilds the extension when its source changed,
starts the API server (`:8000`) and the test pages (`:5500`), loads Gemma into memory, and opens
the test page and "What the AI sees" in Chrome. `Ctrl+C` stops it. Options:
`npm start -- --no-open`, `npm start -- --build`.

Load the extension once: `chrome://extensions` → Developer mode → **Load unpacked** →
`extension/dist/chrome`. Pin it from the puzzle-piece menu. After a rebuild, press its reload arrow.

<details><summary>Manual start, step by step</summary>

```bash
npm install
npm run build                       # -> extension/dist/chrome and extension/dist/firefox
npm run server:install              # once: creates server/.venv
npm run server:dev                  # terminal 1: API on http://127.0.0.1:8000
python -m http.server 5500 --bind 127.0.0.1 --directory demo    # terminal 2: test pages
```

</details>

Use it: open <http://127.0.0.1:5500>, click the extension icon, press **Demo task** (or type your
own), then **Run task**. Open <http://127.0.0.1:8000/debug/view> to see what the AI received.

Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `extension/dist/firefox/manifest.json`,
then grant the site permissions in `about:addons`.

## Tests and proof

```bash
npm run typecheck
npm test                  # perception (face detection, PII, redaction) + extension bundle tests
npm run server:test       # server unit tests, no Ollama needed
npm run server:test:gemma # one live Gemma round-trip
npm run e2e               # real Chrome + real extension + real Gemma on the demo page -> e2e/proof/
```

| Suite | What it proves |
| --- | --- |
| `perception/test/face-detector.test.ts` | Real detections on public-domain photos, annotated images in `test/output/` |
| `perception/test/redaction.test.ts` | Faces blacked out with margin; detector finds nothing afterwards |
| `perception/test/pii.test.ts` | PII detection, no false positives on ordinary numbers, field rules |
| `perception/test/ui-detector.test.ts` | Our UI detector on held-out demo screenshots, scored against their DOM boxes |
| `extension/test/step.test.mjs` | The built worker with the real model sends only masked pixels; multi-step tasks |
| `server/tests/` | Contract, prompt, parser, retries, error mapping, debug view |
| `e2e/run-demo.mjs` | The whole system in Chrome; latest proof in `e2e/proof/` |
| `e2e/run-ask.mjs` | Questions go to ask mode in real Chrome: "Analyze this login page" changes no field |
| `e2e/run-profile.mjs` | A job application is filled from saved details; the values never reach the server |
| `e2e/popup-screens.mjs` | Drives the real popup (Run task, Allow, Ask) and the My info page, saves screenshots |

## Compression study

Eight variants of the face detector (two input sizes × original, cleaned graph, FP16, INT8
dynamic, INT8 static) measured for size, speed, memory and accuracy with the same runtime the
extension uses. Full table: [`perception/benchmarks/RESULTS.md`](perception/benchmarks/RESULTS.md).
Headline: fixing the export's graph gives **1.5x** speed at identical accuracy (now shipped);
FP16 halves size at 99.6% box overlap; INT8 shrinks the file 45-60% but runs slower in WASM.

## My info: fill forms with your saved details

Save details once on the extension's **My info** page (name, email, phone, college, skills, plus
any fields you add by typing their name), then say "Fill this form with my saved details".

- **Several people.** Save yourself, a parent, a friend. The popup's "as" selector picks who to
  fill as, and a task that names a saved person ("fill this with Father's details") uses them.
- **Files.** Save a resume, certificates or a photo per person (up to 10 MB each, kept in the
  extension's IndexedDB). The agent attaches them to file-upload fields.

The values never leave the device:

1. They are stored in `chrome.storage.local` only.
2. The reasoner is sent the **names** of the saved details (`{{email}} = Email`), never the values.
3. It answers with a placeholder: `{"action": "type", "target": "el_4", "text": "{{email}}"}`.
4. The extension replaces the placeholder with the real value just before typing.
5. Fields filled this way are blacked out in every later screenshot, and history keeps the
   placeholder.
6. A saved file goes straight from the extension into the page's file field. Neither its bytes
   nor its name are sent to the server.

Proof: `npm run profile --workspace=e2e` saves two people and a PDF, fills the job application in
`demo/apply.html` with real Gemma (11 fields plus the resume upload), fills it again as the second
person, and checks that no saved value or file name appears in anything the server received
(`e2e/proof/profile.json`).

## Safety: asking vs acting

| Guard | What it prevents |
| --- | --- |
| **Ask mode** | Questions ("analyze this login page", "what does this form ask for?") are answered from the page's visible text and never click or type. `POST /ask` returns text, not actions. Personal data in that text is replaced on-device by placeholders such as `[HIDDEN EMAIL]`. |
| **Typed text must come from the task** | The agent cannot invent names, usernames or passwords. Anything not in the task is refused and the user is asked. |
| **Confirm risky clicks** | Log in, submit, pay, buy, delete, send and similar actions wait for **Allow** in the popup (2-minute timeout, Stop refuses). |
| **No repeats** | The same action twice in a row is refused and the task stops. |

Proof: `npm run ask --workspace=e2e` runs "Analyze this login page" on `demo/login.html` in real
Chrome and checks that no field changed (`e2e/proof/ask.json`).

## UI detector

A YOLO11n model we trained to find buttons, inputs and links **from the screenshot alone**
(10.6 MB, runs in the extension). Training data is generated: headless Chrome renders 1,700
random web pages and the DOM gives exact labels for free. On the original demo page, which it
never saw in training, it finds **97.5%** of the elements with **97.5%** precision. On the
redesigned, more modern demo page it finds **76%** with **64%** precision (inputs 97% / 95%):
strong on familiar styling, weaker on unfamiliar styling, and measured live either way.
The extension compares its boxes with the DOM on every step and "What the AI sees" draws them.
Details: [`perception/ui-model/`](perception/ui-model/README.md).

## Data contract

Defined in [`shared/`](shared/) and mirrored in `server/app/schemas.py`. Request:
`SanitizedContext` (task, page, viewport, sanitized elements, redacted screenshot, redacted
regions, history). Response: `ActionCommand` (`click`, `type`, `scroll`, `navigate`, `wait`,
`done`, `ask_user`, `noop`). Examples in `shared/examples/` are validated against both sides.

## Next steps

| Item | Why |
| --- | --- |
| Act on vision-only elements | The UI detector's boxes are measured and shown; merging unmatched ones into the element list would cover canvas apps, images of buttons and cross-origin frames |
| Train the UI detector on real sites | Today it is trained on generated pages; screenshots of real sites labelled from their DOM would close the gap on icons and custom widgets |
| OCR-based PII detection | PII inside images (a photo of a card) is not caught by text rules |
| In-browser benchmark page and WebGPU | Measure memory/speed inside Chrome; test GPU execution |
| Frames, big pages, navigation across pages | Needed for real websites beyond the test page |

## Security note

Redaction is rule- and model-based: it catches faces, sensitive form fields and well-formatted
PII, and will miss unusual formats and text inside images. The server stores what it receives
in `server/debug_captures/` for the debug view (disable with `ODPA_DEBUG_VIEW=0`). Keep the
server on `localhost`.

## License

MIT
