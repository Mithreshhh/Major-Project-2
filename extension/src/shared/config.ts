import { DEFAULT_SERVER_URL, type ScreenshotMimeType } from "@odpa/shared";

/** Injected by scripts/build.mjs. */
declare const __BROWSER__: "chrome" | "firefox";

export const BROWSER = __BROWSER__;

export const CONFIG = {
  /** Base URL of the FastAPI server. Override at runtime via chrome.storage.local { serverUrl }. */
  serverUrl: DEFAULT_SERVER_URL,

  /** Task used when the user has not set one via chrome.storage.local { task }. */
  defaultTask: "Describe the next reasonable action on this page",

  /** Set to false to send DOM-only context (no pixels) to the server. */
  sendScreenshot: true,
  screenshotMimeType: "image/jpeg" as ScreenshotMimeType,
  screenshotQuality: 0.8,

  /** Upper bound on UI elements included in one snapshot. */
  maxElements: 200,

  /** Network timeout for /process. */
  requestTimeoutMs: 30_000,

  perception: {
    /**
     * TODO(model): point at the ViT once it ships, e.g.
     *   modelUrl: chrome.runtime.getURL("models/vit-tiny-ui-v0.onnx")
     * Keep `null` to run in placeholder mode.
     */
    modelUrl: null as string | null,
    modelId: "vit-tiny-ui-v0",
    inputSize: 224,
  },
} as const;
