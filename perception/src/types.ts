import type { BoundingBox, RedactionMethod, SensitiveCategory, UIElement } from "@odpa/shared";

/**
 * Decoded RGBA bitmap. `data.length === width * height * 4`.
 * This is the common currency between the extension (which decodes screenshots) and this
 * package (which runs models over them and masks regions in place).
 */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * A sensitive region found by the on-device detector.
 *
 * Same fields as the wire `RedactedRegion`, but `bbox` is in *screenshot pixels*, not CSS
 * pixels. The redaction layer divides by devicePixelRatio when it builds the wire payload.
 */
export interface SensitiveRegion {
  bbox: BoundingBox;
  category: SensitiveCategory;
  /** 0..1 detector confidence. */
  confidence: number;
  /** "ml" for detector output; "dom"/"heuristic" once DOM and text detectors feed the mask too. */
  method: RedactionMethod;
}

export interface PerceptionOutput {
  /** Identifier of the model that produced this output, e.g. "ultraface-rfb-640". */
  modelId: string;
  latencyMs: number;
  /**
   * REAL detections. Today: human faces from the UltraFace detector. Screenshot pixel space.
   * Anything in here must be masked before pixels leave the device.
   */
  sensitiveRegions: SensitiveRegion[];
  /**
   * Always empty from the face detector. Visual UI detection is ./ui-detector.ts, whose boxes
   * travel as `PerceptionSummary.visualElements`.
   */
  uiElements: UIElement[];
  /** Optional global embedding of the screen. Not produced by the face detector. */
  embedding?: Float32Array;
}

export type ExecutionProvider = "wasm" | "webgpu";

export interface PerceptionConfig {
  /**
   * Where to load the detector from. A URL (extension: chrome.runtime.getURL("models/...")),
   * or `null` for "no model" (runInference then throws; use placeholderOutput() instead).
   */
  modelUrl: string | null;
  /** Raw model bytes; takes precedence over `modelUrl`. Used by the Node tests. */
  modelBytes?: Uint8Array;
  /** Reported in `PerceptionOutput.modelId`. */
  modelId: string;
  /**
   * Full URL of `ort-wasm-simd-threaded.wasm`, e.g. chrome.runtime.getURL("ort/ort-wasm-simd-threaded.wasm").
   *
   * It is passed to ONNX Runtime as `wasmPaths: { wasm: url }`. That object form (together with
   * numThreads 1) is what makes ORT use the JS glue embedded in its bundle instead of a dynamic
   * `import()`, and dynamic import is not available inside an MV3 service worker. A directory
   * prefix string would force the import and fail there.
   *
   * `null` lets the runtime find the binary itself, which is what you want under Node.
   */
  wasmUrl: string | null;
  /** Preferred execution providers, in order. */
  executionProviders: ExecutionProvider[];
  /** WASM thread count. Keep at 1 inside MV3 service workers (no SharedArrayBuffer). */
  numThreads: number;
  /** Minimum face score to keep. Lower = better recall, more false positives. */
  scoreThreshold: number;
  /** IoU above which two boxes are considered duplicates in NMS. */
  iouThreshold: number;
  /** Cap on detections returned per frame. */
  maxDetections: number;
  /** Network input size; used only if the model's input dims are symbolic. */
  inputWidth: number;
  inputHeight: number;
}

export const DEFAULT_PERCEPTION_CONFIG: PerceptionConfig = {
  modelUrl: null,
  modelId: "ultraface-rfb-640",
  wasmUrl: null,
  executionProviders: ["wasm"],
  numThreads: 1,
  scoreThreshold: 0.6,
  iouThreshold: 0.3,
  maxDetections: 50,
  inputWidth: 640,
  inputHeight: 480,
};
