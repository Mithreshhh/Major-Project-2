# @odpa/perception

On-device ML that runs *inside the extension*, before anything leaves the browser.

| File | Purpose | Status |
| --- | --- | --- |
| `src/inference.ts` | ONNX Runtime Web session + UltraFace face detection | **Real** |
| `src/preprocess.ts` | RGBA bitmap -> normalised NCHW float32 tensor | Real |
| `src/postprocess.ts` | Threshold, pixel mapping, hard NMS | Real |
| `src/redaction.ts` | Black out faces, sensitive fields and PII text in the pixels; redact labels; `sanitize()` pipeline entry point | **Real** |
| `src/pii.ts` | Email / phone / card (Luhn) / SSN / Aadhaar / PAN detection, field rules, `scrubUrl` | **Real**, dependency-free (the content script imports it) |
| `benchmarks/` | Compression study: `quantize.py` builds variants, `npm run benchmark` measures them | Results in `benchmarks/RESULTS.md` |
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

## Redaction

`redact(image, regions)` paints an opaque black box over each region on a **new** buffer and
never touches the input; `wipeSource: true` additionally zeroes the input afterwards, which is
what the `sanitize()` pipeline does so unmasked pixels stop existing as soon as possible. Each
box is grown by 15% of its own size per side (4 px minimum) and snapped outward to whole
pixels, because detector boxes hug the face and an under-redacted edge defeats the purpose.
With no regions the input object comes back unchanged and `changed` is false: a real "nothing
sensitive found" result, since `runInference` throws when no model ran.

Black boxes, not blur: blur can be partially inverted; a solid fill destroys the information.

## Test

```bash
npm test                                          # detector + redaction over test/fixtures/
PERCEPTION_MODEL=version-RFB-320.onnx npm test     # same, with the smaller export
```

`face-detector.test.ts` prints every detected box with its confidence and writes annotated
copies to `test/output/*.detections.jpg`. `redaction.test.ts` feeds those detections into
`redact()`, writes `test/output/*.redacted.jpg`, checks every pixel inside the padded boxes is
black and every pixel outside is untouched, and finally runs the detector on the redacted
image to confirm no face survives. Fixtures are public-domain or CC0 images (see
`test/fixtures/README.md`); `npm run fixtures:fetch` regenerates them.

## Runtime constraints (MV3)

The extension hosts this code in the background service worker: single-threaded WASM, no proxy
worker, `'wasm-unsafe-eval'` in the manifest CSP, and the `.wasm` shipped inside the extension.
Two details matter there:

- `wasmUrl` must be passed and ORT receives it as `wasmPaths: { wasm: url }`. That object form
  (with one thread) makes ORT use the JS glue embedded in its bundle. A directory prefix string
  makes it dynamic-`import()` the glue instead, which service workers do not allow.
- The extension build aliases `onnxruntime-web` to `onnxruntime-web/wasm`, so the embedded glue
  matches `ort-wasm-simd-threaded.wasm` (13 MB) rather than the WebGPU variant (26 MB). This
  package keeps the root import so Node tests get ORT's Node build.

The build copies `models/*.onnx` into `dist/<browser>/models/`.

## Compression study

`benchmarks/quantize.py` builds, for both input sizes, a cleaned-graph FP32, an FP16, an INT8
dynamic and an INT8 static (calibrated) variant into `models/compressed/`. `npm run benchmark`
measures each one in a fresh process with the runtime the extension ships and writes
`benchmarks/RESULTS.md` and `benchmarks/results.json`.

Findings on this machine (single-threaded WASM):

- **Graph cleanup is the biggest win.** The upstream export lists every weight as a graph input,
  which blocks ONNX Runtime's constant folding and Conv+BatchNorm fusion. Fixing only that makes
  RFB-640 1.5x faster (median 81 -> 54 ms) with identical boxes. The extension now ships it.
- **FP16 halves the file** (1.5 MB -> 0.8 MB) at 99.6% box overlap and the same speed, but uses
  more memory because WASM computes in FP32 and inserts casts.
- **INT8 shrinks the file 45-60% but is slower** in WASM: dynamic quantization adds per-call
  overhead and the WASM backend has limited int8 convolution kernels. Static INT8 also loses
  the most box precision (IoU 0.93). INT8 is the right choice on native CPUs, not in the browser.
- Every variant finds all 4 test faces with zero false positives on the true-negative image.

```bash
python -m venv benchmarks/.venv && benchmarks/.venv/Scripts/pip install -r benchmarks/requirements.txt
benchmarks/.venv/Scripts/python benchmarks/quantize.py
npm run benchmark
```
