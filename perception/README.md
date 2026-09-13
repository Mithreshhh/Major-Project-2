# @odpa/perception

On-device ML that runs *inside the extension*, before anything leaves the browser.

| File | Purpose | Status |
| --- | --- | --- |
| `src/inference.ts` | ONNX Runtime Web session lifecycle + ViT forward pass | Runtime wired, model `TODO(model)` |
| `src/redaction.ts` | Detect + mask sensitive regions (DOM, text, ML) | Pass-through stubs, `TODO(redaction)` |
| `src/types.ts` | `RawImage`, `PerceptionOutput`, `PerceptionConfig` | Done |

## Where the real work goes

Search the sources for `TODO(model)` and `TODO(redaction)`.

- **Model**: export a lightweight ViT (e.g. ViT-Tiny / MobileViT / DeiT-Tiny fine-tuned on UI
  screenshots) to ONNX, drop it in `extension/public/models/`, set `modelUrl` in
  `extension/src/shared/config.ts`, then fill in `preprocess`, `postprocess`, and the
  `InferenceSession.create` call in `inference.ts`.
- **Redaction**: implement the three detectors and the in-place pixel mask in `redaction.ts`.
  Until then the pipeline forwards data *unredacted*: only test against local pages.

## Runtime constraints (MV3)

The extension hosts this code in the background service worker. There, ONNX Runtime Web must
run single-threaded WASM without a proxy worker, and the manifest must allow
`'wasm-unsafe-eval'`. Both are already configured. WebGPU, if wanted later, should live in an
offscreen document instead.
