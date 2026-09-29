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
   * Password/card fields and PII text (emails, phones, card and ID numbers) are blacked out
   * too, and PII in element labels, the page title and the URL is replaced with "[REDACTED]".
   */
  sendScreenshot: true as boolean,
  /**
   * Black out every photo, video and canvas on the page (found from the DOM), not only the
   * faces the model finds. Small avatars (chat lists, comments) are below what the face model
   * can see, so this is the guarantee; the face model still covers faces in any other pixels.
   */
  hidePhotos: true as boolean,
  screenshotMimeType: "image/jpeg" as ScreenshotMimeType,
  screenshotQuality: 0.8,

  /** Upper bound on UI elements included in one snapshot. */
  maxElements: 200,

  /** Network timeout for /process. The first call may include loading Gemma (~10 s). */
  requestTimeoutMs: 60_000,

  /** A task from the popup stops after this many steps even if the model has not said "done". */
  maxTaskSteps: 10,
  /** Pause between steps so the page can react (animations, validation messages). */
  stepDelayMs: 700,

  /** Server page that shows the last sanitized screenshots it received. */
  debugViewPath: "/debug/view",

  perception: {
    /**
     * UltraFace face detector, copied from perception/models into dist/<browser>/models by the
     * build. RFB-640 for recall on small faces, cleaned-graph FP32: the winner of the
     * compression study (perception/benchmarks/RESULTS.md), 1.5x faster than the original
     * export with identical boxes. Swap to version-RFB-320.fp32-clean.onnx for ~3x less compute.
     * Only loaded when sendScreenshot is true (there is nothing to look at otherwise).
     */
    modelUrl: chrome.runtime.getURL("models/version-RFB-640.fp32-clean.onnx") as string | null,
    modelId: "ultraface-rfb-640-clean",
    scoreThreshold: 0.6,
  },

  uiDetector: {
    /**
     * YOLO11n trained by perception/ui-model on synthetic pages labelled from the DOM. Finds
     * buttons, inputs and links from pixels. Runs on the raw screenshot before redaction; only
     * boxes leave the device. Optional: if it fails to load or run, the step continues without it.
     */
    enabled: true as boolean,
    modelUrl: chrome.runtime.getURL("models/ui-detect.onnx") as string,
    modelId: "ui-detect-yolo11n",
    /** 0.5: 97.5% recall and 97.5% precision on the held-out demo page (ui-model/RESULTS.md). */
    scoreThreshold: 0.5,
  },
} as const;
