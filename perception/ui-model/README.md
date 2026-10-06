# UI detector: buttons, inputs and links from pixels

A YOLO11n object detector (2.6 M parameters, 10.6 MB ONNX) that runs inside the extension on
every screenshot and finds **buttons, inputs and links from the image alone**. The extension
compares its boxes with the DOM on every step, so its accuracy is measured live, and the
"What the AI sees" page draws them as dashed boxes.

## Results

The demo page is **never used in training**. It was redesigned once, so there are two held-out
tests, both at the extension's confidence threshold of 0.5.

| Held-out test | Recall (real elements found) | Precision (boxes that are real) |
| --- | --- | --- |
| Original demo page (plain styling), 21 screenshots, 199 elements | **97.5%** | **97.5%** |
| Redesigned demo page (glass nav, gradient buttons, pill badges), 21 screenshots, 223 elements | **76.2%** | **63.9%** |
| 200 held-out generated pages | 98.2% | 99.2% |

On the redesigned page, by class: inputs 96.9% recall / 94.9% precision, buttons 100% / 21.2%,
links 54.1% / 71.1%. Full tables at every threshold: [`RESULTS.md`](RESULTS.md) (current model,
redesigned page). In real Chrome it finds 10 of 12 controls on the contact page.

What the three training rounds taught us:

| Round | Change to the data | Effect |
| --- | --- | --- |
| 1 | Generated pages only | Original page: 97% recall but 55% precision. Short grey labels were called "links". |
| 2 | Added look-alikes that are not controls (label/value lists, log panels, code boxes) | Original page: precision 55% → 97.5%. |
| 3 | Added modern styling (tinted inputs, gradient buttons, muted nav links, dark console panels) after the page redesign | Redesigned page: recall 59.6% → 76.2%, precision 45.2% → 63.9%. Still perfect on the original-page test screenshots. |

What is still wrong on the redesigned page: pill-shaped badges and the logo are called buttons,
and muted navigation and footer links are missed. That is the honest picture: the detector is
strong on styles close to its training pages and drops on unfamiliar ones, which is why the
extension scores it against the DOM on every step instead of trusting it. Real-site training
data is the next step.

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
