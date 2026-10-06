# UI detector: buttons, inputs and links from pixels

A YOLO11n object detector (2.6 M parameters, 10.6 MB ONNX) that runs inside the extension on
every screenshot and finds **buttons, inputs and links from the image alone**. The extension
compares its boxes with the DOM on every step, so its accuracy is measured live, and the
"What the AI sees" page draws them as dashed boxes.

## Results

The test site is **never used in training**. All numbers are at the extension's confidence
threshold of 0.5, measured with the extension's own code (`evaluate.ts`).

| Held-out test | Recall (real elements found) | Precision (boxes that are real) |
| --- | --- | --- |
| Original demo page (plain styling), 21 screenshots, 199 elements; round-2 model | **97.5%** | **97.5%** |
| Whole test site today (contact, application, store, pricing, features, login), 51 screenshots, 531 elements; current model | **61.2%** | **55.0%** |
| 200 held-out generated pages; current model | 97.2% | 98.7% |

On the whole site, by class: inputs 96.8% recall / 89.8% precision, buttons 71.7% / 48.3%,
links 41.8% / 39.4%. Full tables at every threshold: [`RESULTS.md`](RESULTS.md). The current
model is still right on the saved screenshots of the original page (`npm test`).

What four training rounds taught us:

| Round | Change to the data | Effect |
| --- | --- | --- |
| 1 | Generated pages only | Original page: 97% recall but 55% precision. Short grey labels were called "links". |
| 2 | Added look-alikes that are not controls (label/value lists, log panels, code boxes) | Original page: precision 55% → 97.5%. |
| 3 | Added modern styling (tinted inputs, gradient buttons, muted nav links, console panels) after the page was redesigned | Redesigned contact page: recall 59.6% → 76.2%, precision 45.2% → 63.9%. |
| 4 | Added logo links, pill badges, plain "Log in" links, one-row footers, coloured headline words | Whole site (Ultralytics validation at 0.5): precision 48% → 63%, recall 66% → 70%. |

The honest picture: generated pages are easy (97%+), form inputs carry over to new designs
(97%), and links and buttons on unfamiliar layouts are the weak spot. Every redesign of the test
site moved the numbers, which is exactly why the extension scores the detector against the DOM
on every step instead of trusting it. Training on screenshots of real sites, labelled from their
DOM the same way, is the next step.

`compare.py` compares checkpoints on the held-out pages; `generate.mjs --demo-only` re-shoots only
those pages after the test site changes.

## How it was built

| Step | File | What happens |
| --- | --- | --- |
| 1. Data | `generate.mjs` | Headless Chrome renders 1,700 random web pages (themes, fonts, dark mode, navbars, forms, cards, tables, footers, photos) and reads the exact box of every button, input and link from the DOM. Labels are free and pixel-accurate. About 3 minutes. |
| 2. Hard negatives | `generate.mjs` | Label/value lists, log panels, code boxes, stats and tags that look clickable but are not, so the model learns what is *not* a link or input. Added after the first model mistook grey labels for links. |
| 3. Train | `train.py` | Fine-tunes COCO-pretrained YOLO11n at 640 px on the GPU (RTX 5060, about 1 minute per epoch), then exports ONNX (opset 17, no NMS in the graph). |
| 4. Run | `../src/ui-detector.ts` | Letterbox to 640x640, ONNX Runtime Web (single-threaded WASM, as in the MV3 worker), decode, per-class NMS, map back to screenshot pixels. |
| 5. Score | `../src/ui-detector.ts` `compareWithDom` | Match vision boxes to DOM elements (same class, IoU ≥ 0.5): recall and precision for every step. |
| 6. Evaluate | `evaluate.ts` | Recall/precision at several thresholds on held-out data. Results in `RESULTS.md`. |

**The demo page is never used for training.** Its 21 screenshots (7 window sizes x empty, filled
and scrolled) are the held-out test. `finish.py` evaluates and exports an existing checkpoint
when a training run was stopped early.

## Reproduce

```bash
cd perception
python -m venv benchmarks/.venv            # shared with the compression study
benchmarks/.venv/Scripts/pip install ultralytics
benchmarks/.venv/Scripts/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
node ui-model/generate.mjs 1500 200        # -> ui-model/dataset/
cd ui-model && ../benchmarks/.venv/Scripts/python train.py 40   # -> ../models/ui-detect.onnx
cd .. && npx tsx ui-model/evaluate.ts      # -> ui-model/RESULTS.md
npm test                                   # includes test/ui-detector.test.ts
```

`preview.py` draws the labels on any dataset image, to check them by eye.

## Why not an off-the-shelf model

We first tried Microsoft OmniParser v2's `icon_detect`. It turned out to be YOLO11m (20 M
parameters, 77 MB ONNX, 272 GFLOPs at its native 1280 px) and could not even finish loading in
single-threaded WASM within 5 minutes, so it is unusable inside a browser extension. Training our own
nano model on auto-labelled pages gave a 7x smaller model with three classes instead of one.

## Limits

- Trained on synthetic pages. Real sites have icons, images of text and custom widgets it has not
  seen; the live DOM comparison in the extension shows where it misses.
- About 0.4-0.8 s per screenshot in single-threaded WASM. WebGPU in an offscreen document would
  make it several times faster.
- Licences: YOLO11 weights and Ultralytics are AGPL-3.0, fine for this academic project.
