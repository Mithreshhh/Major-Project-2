/**
 * @odpa/perception
 *
 * Everything that runs on-device, before any data leaves the browser:
 *
 *   1. `inference.ts`    ONNX Runtime Web session management + UltraFace face detection.
 *   2. `preprocess.ts`   RGBA bitmap -> normalised NCHW tensor (pure TypeScript).
 *   3. `postprocess.ts`  scores/boxes -> thresholded, NMS-filtered pixel-space regions.
 *   4. `redaction.ts`    Masking of faces, sensitive fields and PII text in the screenshot and DOM.
 *   5. `ui-detector.ts`  YOLO11n detection of buttons, inputs and links from pixels.
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
export * from "./ui-detector";
export { classifyField, findPii, luhnValid, redactTextLabelled, scrubUrl, type PiiMatch } from "./pii";
export * from "./ocr";
