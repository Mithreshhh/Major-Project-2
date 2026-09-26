# @odpa/perception

On-device ML that runs *inside the extension*, before anything leaves the browser.

| File | Purpose | Status |
| --- | --- | --- |
| `src/inference.ts` | ONNX Runtime Web session + UltraFace face detection | **Real** |
| `src/preprocess.ts` | RGBA bitmap -> normalised NCHW float32 tensor | Real |
| `src/postprocess.ts` | Threshold, pixel mapping, hard NMS | Real |
| `src/redaction.ts` | Mask sensitive regions in pixels and DOM summary | Pass-through stubs, `TODO(redaction)` |
| `src/types.ts` | `RawImage`, `PerceptionOutput`, `PerceptionConfig` | Done |
| `models/*.onnx` | UltraFace RFB-320 and RFB-640 | Committed, checksummed |

`PerceptionOutput` now has two lists. `sensitiveRegions` is real: faces, in screenshot pixel
space, shaped like the wire `RedactedRegion` (`bbox`, `category: "face"`, `confidence`,
`method: "ml"`). `uiElements` is a clearly labelled placeholder: always empty, shaped like the
wire `UIElement`, until a fine-tuned UI detector exists (`TODO(ui-model)`).

## The model and why

**Ultra-Light-Fast-Generic-Face-Detector-1MB (UltraFace), RFB variant** by Linzaer, MIT licence.
Source: <https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB>,
files `models/onnx/version-RFB-320.onnx` and `version-RFB-640.onnx`. The same 320 export is
also published in the ONNX Model Zoo under `vision/body_analysis/ultraface`.

| File | Input | Anchors | Size | SHA-256 |
| --- | --- | --- | --- | --- |
| `version-RFB-320.onnx` | 1x3x240x320 | 4420 | 1.27 MB | `34cd7e60aeff2874…` |
| `version-RFB-640.onnx` | 1x3x480x640 | 17640 | 1.59 MB | `8f4c659275977e7a…` |

Full hashes live in `scripts/fetch-models.mjs`, which re-downloads and verifies them.

Why this over BlazeFace, RetinaFace-MobileNet or YuNet:

- **Trivial post-processing.** The export already contains softmax and anchor decoding, so the
  browser side is resize, normalise, threshold, NMS. BlazeFace, RetinaFace and YuNet all need
  anchor or prior generation reproduced exactly in TypeScript, which is where ports go wrong.
- **Plain operators.** Conv, BatchNorm, ReLU, Concat, Softmax at opset 9. Runs on the ONNX
  Runtime Web WASM backend today, including single-threaded inside an MV3 service worker, and
  the same graph runs on WebGPU when an offscreen document is added.
- **Small and permissive.** Under 2 MB, MIT, no external data files.
- **Suited to screenshots.** The 640x480 export handles the small faces typical of avatars and
  thumbnails in web pages. RFB-320 is available for roughly four times less compute.

Trade-offs to know: input is resized without preserving aspect ratio (the upstream reference
does the same, and boxes are mapped back proportionally), there are no landmarks, and it
detects human faces only. Other sensitive categories (card numbers, ID documents) will need
text-based detection in the redaction layer.

## Detection settings

`PerceptionConfig` defaults: `scoreThreshold` 0.6, `iouThreshold` 0.3, `maxDetections` 50.
Lower the score threshold for recall at the cost of false positives on illustrations.

## Measured behaviour (single-threaded WASM under Node, this repo's fixtures)

| Image | RFB-640 | RFB-320 |
| --- | --- | --- |
| Portrait, one face (512x512) | 1 face, confidence 1.00, ~90 ms | 1 face, confidence 1.00, ~40 ms |
| Apollo 11 crew, three faces (960x754) | 3 faces, all ≥ 0.998, ~65 ms | 3 faces, all ≥ 0.999, ~25 ms |
| Coffee cup, no face | 0 | 0 |
| Cat photo (confuser) | 1 box on the cat's face at 0.63 | 2 boxes at 0.89 and 0.69 |
| Flat grey 640x480 | 0 | 0 |

The cat result is typical for compact human-face detectors and is the safe failure mode for
redaction (an extra masked region rather than a missed face). Expect the same on pet photos
and some cartoon avatars.

## Test

```bash
npm test                                          # runs the real detector over test/fixtures/
PERCEPTION_MODEL=version-RFB-320.onnx npm test     # same, with the smaller export
```

The test prints every detected box with its confidence and writes annotated copies to
`test/output/*.detections.jpg` for visual checking. Fixtures are public-domain or CC0 images
(see `test/fixtures/README.md`); `npm run fixtures:fetch` regenerates them.

## Runtime constraints (MV3)

The extension hosts this code in the background service worker: single-threaded WASM, no proxy
worker, `'wasm-unsafe-eval'` in the manifest CSP, and the `.wasm` shipped inside the extension.
All already configured. The build copies `models/*.onnx` into `dist/<browser>/models/`.
