# UI detector: buttons, inputs and links from pixels

A YOLO11n object detector (2.6 M parameters, 10.6 MB ONNX) that runs inside the extension on
every screenshot and finds **buttons, inputs and links from the image alone**. The extension
compares its boxes with the DOM on every step, so its accuracy is measured live, and the
"What the AI sees" page draws them as dashed boxes.

## Results

On the demo page, which was **never used in training** (21 screenshots, 199 elements), at the
extension's confidence threshold of 0.5:

| | Recall (real elements found) | Precision (boxes that are real) |
| --- | --- | --- |
| All | **97.5%** (194/199) | **97.5%** (194/199) |
| Buttons | 100% | 100% |
| Inputs | 95.1% | 100% |
| Links | 100% | 91.5% |

On 200 held-out generated pages: 97.8% recall, 98.5% precision. Full tables at every threshold:
[`RESULTS.md`](RESULTS.md). In real Chrome, inside the extension, it found 10/10 elements on
every step of the demo task in 0.3-0.65 s.

The data fix mattered more than the model. The first round (no hard negatives) had 97% recall
but only 55% precision on the demo page, because it called short grey labels "links". Adding
look-alike non-interactive content and fine-tuning for 25 epochs raised precision to 97.5%.

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
and scrolled) are the held-out test.

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
