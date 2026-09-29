/**
 * @odpa/perception
 *
 * Everything that runs on-device, before any data leaves the browser:
 *
 *   1. `inference.ts`    ONNX Runtime Web session management + UltraFace face detection.
 *   2. `preprocess.ts`   RGBA bitmap -> normalised NCHW tensor (pure TypeScript).
 *   3. `postprocess.ts`  scores/boxes -> thresholded, NMS-filtered pixel-space regions.
 *   4. `redaction.ts`    Masking of sensitive regions in the screenshot and DOM (still stubbed).
 *
 * This package is framework-agnostic: it knows nothing about chrome.* APIs. The extension's
 * background worker owns the browser plumbing (capturing the tab, decoding the PNG, etc.) and
 * hands plain `RawImage` buffers in here.
 */
export * from "./types";
export * from "./inference";
export * from "./preprocess";
export * from "./postprocess";
export * from "./redaction";
export { classifyField, findPii, luhnValid, scrubUrl, type PiiMatch } from "./pii";
