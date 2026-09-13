/**
 * @odpa/perception
 *
 * Everything that runs on-device, before any data leaves the browser:
 *
 *   1. `inference.ts`  ONNX Runtime Web session management + the (placeholder) ViT forward pass.
 *   2. `redaction.ts`  Detection and masking of sensitive regions in the screenshot and DOM.
 *
 * This package is framework-agnostic: it knows nothing about chrome.* APIs. The extension's
 * background worker owns the browser plumbing (capturing the tab, decoding the PNG, etc.) and
 * hands plain `RawImage` buffers in here.
 */
export * from "./types";
export * from "./inference";
export * from "./redaction";
