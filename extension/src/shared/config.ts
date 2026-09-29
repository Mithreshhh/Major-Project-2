import { DEFAULT_SERVER_URL, type ScreenshotMimeType } from "@odpa/shared";

/** Injected by scripts/build.mjs. */
declare const __BROWSER__: "chrome" | "firefox";

export const BROWSER = __BROWSER__;

export const CONFIG = {
  /** Base URL of the FastAPI server. Override at runtime via chrome.storage.local { serverUrl }. */
  serverUrl: DEFAULT_SERVER_URL,

  /** Task used when the user has not set one via chrome.storage.local { task }. */
  defaultTask: "Describe the next reasonable action on this page",

  /**
   * true:  capture the visible tab, run the on-device face detector, black out every detected
   *        face (with margin) on a fresh copy, zero the raw buffer, and send the masked copy.
   *        A failure anywhere in that chain aborts the step; raw pixels are never sent.
   * false: the step never calls captureVisibleTab, never decodes or encodes pixels, never loads
   *        the model, and sends `screenshot: null`.
   * Text/DOM redaction is still TODO, so labels and the page URL are forwarded as captured.
   */
  sendScreenshot: true as boolean,
  screenshotMimeType: "image/jpeg" as ScreenshotMimeType,
  screenshotQuality: 0.8,

  /** Upper bound on UI elements included in one snapshot. */
  maxElements: 200,

  /** Network timeout for /process. */
  requestTimeoutMs: 30_000,

  perception: {
    /**
     * UltraFace face detector, copied from perception/models into dist/<browser>/models by the
     * build. RFB-640 for recall on small faces; swap to version-RFB-320.onnx for ~4x less compute.
     * Only loaded when sendScreenshot is true (there is nothing to look at otherwise).
     */
    modelUrl: chrome.runtime.getURL("models/version-RFB-640.onnx") as string | null,
    modelId: "ultraface-rfb-640",
    scoreThreshold: 0.6,
  },
} as const;
