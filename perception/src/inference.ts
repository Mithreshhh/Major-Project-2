/**
 * ONNX Runtime Web integration for the on-device ViT.
 *
 * Status: SCAFFOLD. The runtime is wired up (env configuration, session lifecycle, typed I/O),
 * but no model is loaded and no tensors are produced yet. Every place that needs real model
 * logic is marked with `TODO(model)`.
 *
 * Runtime notes for later:
 *   - Inside an MV3 service worker there is no SharedArrayBuffer and no `import()`, so:
 *       * numThreads must be 1,
 *       * ort.env.wasm.proxy must be false,
 *       * the extension manifest needs `'wasm-unsafe-eval'` in its CSP (already set),
 *       * the .wasm files must ship inside the extension (the build script copies them to /ort).
 *   - If WebGPU is wanted later, an offscreen document is the safer host than the worker.
 */
import * as ort from "onnxruntime-web";

import type { PerceptionConfig, PerceptionOutput, RawImage } from "./types";
import { DEFAULT_PERCEPTION_CONFIG } from "./types";

/** Reported as `modelId` whenever no real model is loaded. */
export const PLACEHOLDER_MODEL_ID = "placeholder";

let session: ort.InferenceSession | null = null;
let activeConfig: PerceptionConfig = DEFAULT_PERCEPTION_CONFIG;

/** Apply runtime-wide ONNX Runtime settings. Safe to call more than once. */
export function configureRuntime(config: Partial<PerceptionConfig> = {}): PerceptionConfig {
  activeConfig = { ...DEFAULT_PERCEPTION_CONFIG, ...config };

  ort.env.wasm.wasmPaths = activeConfig.wasmBaseUrl;
  ort.env.wasm.numThreads = activeConfig.numThreads;
  ort.env.wasm.proxy = false;
  // Keep ORT quiet unless we are debugging the model.
  ort.env.logLevel = "warning";

  return activeConfig;
}

/**
 * Load the ViT session. Returns `true` when a real model is ready, `false` when running in
 * placeholder mode (no `modelUrl` configured yet).
 */
export async function loadModel(config: Partial<PerceptionConfig> = {}): Promise<boolean> {
  const cfg = configureRuntime(config);

  if (!cfg.modelUrl) {
    session = null;
    return false;
  }

  // TODO(model): enable once a lightweight ViT export (.onnx) is shipped in extension/public/models.
  //   session = await ort.InferenceSession.create(cfg.modelUrl, {
  //     executionProviders: cfg.executionProviders,
  //     graphOptimizationLevel: "all",
  //   });
  //   Validate session.inputNames / session.outputNames against the expected ViT signature here.
  throw new Error(
    "loadModel: a modelUrl was provided but real model loading is not implemented yet (see TODO(model))."
  );
}

/** True when a real ONNX session is loaded (as opposed to placeholder mode). */
export function isModelLoaded(): boolean {
  return session !== null;
}

/** Release the session (e.g. when the extension is suspended). */
export async function disposeModel(): Promise<void> {
  if (session) {
    await session.release();
    session = null;
  }
}

/**
 * Convert an RGBA bitmap into the NCHW float32 tensor a ViT expects.
 *
 * TODO(model): implement
 *   1. resize/letterbox `image` to `inputSize` x `inputSize`,
 *   2. drop alpha, convert to float, apply the model's mean/std normalisation,
 *   3. transpose HWC -> CHW and wrap in `new ort.Tensor("float32", data, [1, 3, S, S])`.
 */
export function preprocess(_image: RawImage, _inputSize: number): ort.Tensor {
  throw new Error("preprocess: not implemented yet (see TODO(model)).");
}

/**
 * Turn raw model outputs into `PerceptionOutput.regions` / `.embedding`.
 *
 * TODO(model): implement once the output head is decided (patch-level classification,
 * detection head, or plain CLS embedding). Map any patch/grid coordinates back to
 * *screenshot pixel* space using the original `image` dimensions.
 */
export function postprocess(
  _outputs: ort.InferenceSession.OnnxValueMapType,
  _image: RawImage
): Pick<PerceptionOutput, "regions" | "embedding"> {
  throw new Error("postprocess: not implemented yet (see TODO(model)).");
}

/**
 * Run the on-device model over a decoded screenshot.
 *
 * In placeholder mode (no model loaded) this resolves immediately with an empty result so the
 * capture -> redact -> server -> execute loop can be developed and tested end-to-end.
 */
export async function runInference(image: RawImage): Promise<PerceptionOutput> {
  const startedAt = performance.now();

  if (!session) {
    return {
      modelId: PLACEHOLDER_MODEL_ID,
      latencyMs: Math.round(performance.now() - startedAt),
      regions: [],
    };
  }

  // TODO(model): real forward pass.
  //   const input = preprocess(image, activeConfig.inputSize);
  //   const feeds = { [session.inputNames[0]!]: input };
  //   const outputs = await session.run(feeds);
  //   const { regions, embedding } = postprocess(outputs, image);
  //   return { modelId: activeConfig.modelId, latencyMs: ..., regions, embedding };
  throw new Error("runInference: model session exists but inference is not implemented yet.");
}

/** Exposed for diagnostics (e.g. an extension options page showing ORT status). */
export function getRuntimeInfo(): { ortVersion: string; config: PerceptionConfig; loaded: boolean } {
  return { ortVersion: ort.env.versions.web ?? "unknown", config: activeConfig, loaded: session !== null };
}
