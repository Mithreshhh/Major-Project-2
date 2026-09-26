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
   * false: the step never calls captureVisibleTab, never decodes or encodes pixels, never loads
   * the on-device model, and sends `screenshot: null`. Keep it off until TODO(redaction) is
   * implemented; until then any captured pixels would leave the device unmasked.
   */
  sendScreenshot: false as boolean,
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
