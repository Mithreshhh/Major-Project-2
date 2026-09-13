import type { BoundingBox } from "@odpa/shared";

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

/** Something the on-device model found in the screenshot. */
export interface DetectedRegion {
  /** In *screenshot pixel* coordinates (not CSS pixels). */
  bbox: BoundingBox;
  /** Model-specific class label, e.g. "text_field", "button", "face". */
  label: string;
  /** 0..1 */
  score: number;
}

export interface PerceptionOutput {
  modelId: string;
  latencyMs: number;
  regions: DetectedRegion[];
  /** Optional global embedding of the screen (e.g. ViT CLS token). */
  embedding?: Float32Array;
}

export type ExecutionProvider = "wasm" | "webgpu";

export interface PerceptionConfig {
  /**
   * URL of the .onnx file. `null` means "no model available yet"; `runInference` then returns a
   * placeholder result so the rest of the pipeline can be exercised end-to-end.
   */
  modelUrl: string | null;
  /** Identifier reported in `PerceptionOutput.modelId` when the model is loaded. */
  modelId: string;
  /** Directory URL that contains the ONNX Runtime Web .wasm files (must end with "/"). */
  wasmBaseUrl: string;
  /** Preferred execution providers, in order. */
  executionProviders: ExecutionProvider[];
  /** Square input resolution expected by the ViT (e.g. 224). */
  inputSize: number;
  /** WASM thread count. Keep at 1 inside MV3 service workers (no SharedArrayBuffer). */
  numThreads: number;
}

export const DEFAULT_PERCEPTION_CONFIG: PerceptionConfig = {
  modelUrl: null,
  modelId: "vit-tiny-ui-v0",
  wasmBaseUrl: "/ort/",
  executionProviders: ["wasm"],
  inputSize: 224,
  numThreads: 1,
};
