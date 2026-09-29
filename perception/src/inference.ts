/**
 * ONNX Runtime Web integration: on-device face detection with UltraFace.
 *
 * Model: Ultra-Light-Fast-Generic-Face-Detector-1MB, RFB variant (Linzaer, MIT licence).
 *   https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB
 *   models/onnx/version-RFB-320.onnx  input 1x3x240x320, 4420 anchors  (~1.3 MB)
 *   models/onnx/version-RFB-640.onnx  input 1x3x480x640, 17640 anchors (~1.6 MB)
 * The ONNX export already applies softmax and anchor decoding, so the JS side only resizes,
 * normalises, thresholds and runs NMS. See ../README.md for why this model and the checksums.
 *
 * Output split:
 *   sensitiveRegions  REAL: faces, in screenshot pixel space
 *   uiElements        always empty here. Visual UI detection is a separate model with its own
 *                     session, see ./ui-detector.ts (sent as perception.visualElements).
 *
 * Runtime notes for MV3 service workers: numThreads 1, proxy false, 'wasm-unsafe-eval' in the
 * manifest CSP, the .wasm shipped inside the extension (the build copies it to /ort), and
 * `wasmPaths` given as `{ wasm: url }` so ORT uses its embedded JS glue rather than a dynamic
 * import() (unavailable in service workers). The extension build also aliases onnxruntime-web
 * to its wasm-only entry point so the embedded glue matches ort-wasm-simd-threaded.wasm.
 */
import type { UIElement } from "@odpa/shared";
import * as ort from "onnxruntime-web";

import { decodeUltraFace, nms, toSensitiveRegions } from "./postprocess";
import { preprocess } from "./preprocess";
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionConfig, type PerceptionOutput, type RawImage } from "./types";

/** `modelId` of outputs produced without running a model (perception intentionally skipped). */
export const PLACEHOLDER_MODEL_ID = "placeholder";

interface LoadedModel {
  session: ort.InferenceSession;
  inputName: string;
  scoresName: string;
  boxesName: string;
  inputWidth: number;
  inputHeight: number;
}

let loaded: LoadedModel | null = null;
let activeConfig: PerceptionConfig = DEFAULT_PERCEPTION_CONFIG;

/** Apply runtime-wide ONNX Runtime settings. Safe to call more than once. */
export function configureRuntime(config: Partial<PerceptionConfig> = {}): PerceptionConfig {
  activeConfig = { ...DEFAULT_PERCEPTION_CONFIG, ...config };
  if (activeConfig.wasmUrl) {
    // Object form on purpose: see PerceptionConfig.wasmUrl.
    ort.env.wasm.wasmPaths = { wasm: activeConfig.wasmUrl };
  }
  ort.env.wasm.numThreads = activeConfig.numThreads;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "warning";
  return activeConfig;
}

/**
 * Load the face detector. Returns `true` when a session is ready, `false` when no model source
 * was configured (callers should then use `placeholderOutput()` rather than `runInference`).
 */
export async function loadModel(config: Partial<PerceptionConfig> = {}): Promise<boolean> {
  const cfg = configureRuntime(config);
  await disposeModel();

  const source = cfg.modelBytes ?? cfg.modelUrl;
  if (!source) return false;

  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: cfg.executionProviders,
    graphOptimizationLevel: "all",
    // The upstream export lists every weight as a graph input; ORT warns once per weight
    // (hundreds of lines). Errors only.
    logSeverityLevel: 3,
  };

  const session =
    typeof source === "string"
      ? await ort.InferenceSession.create(source, options)
      : await ort.InferenceSession.create(source, options);

  loaded = resolveIo(session, cfg);
  return true;
}

/** Work out tensor names and the fixed input size from the session metadata. */
function resolveIo(session: ort.InferenceSession, cfg: PerceptionConfig): LoadedModel {
  const inputs = tensorMetadata(session.inputMetadata);
  const outputs = tensorMetadata(session.outputMetadata);

  const input = inputs.find((m) => m.shape.length === 4) ?? inputs[0];
  const inputName = input?.name ?? session.inputNames[0];
  if (!inputName) throw new Error("loadModel: model has no inputs");

  const dims = input?.shape ?? [];
  const inputHeight = typeof dims[2] === "number" && dims[2] > 0 ? dims[2] : cfg.inputHeight;
  const inputWidth = typeof dims[3] === "number" && dims[3] > 0 ? dims[3] : cfg.inputWidth;

  const byLastDim = (n: number) => outputs.find((m) => m.shape[m.shape.length - 1] === n)?.name;
  const byName = (n: string) => session.outputNames.find((name) => name.toLowerCase() === n);
  const scoresName = byLastDim(2) ?? byName("scores") ?? session.outputNames[0];
  const boxesName = byLastDim(4) ?? byName("boxes") ?? session.outputNames[1];
  if (!scoresName || !boxesName || scoresName === boxesName) {
    throw new Error(
      `loadModel: could not identify UltraFace outputs (scores [1,N,2], boxes [1,N,4]) among ${session.outputNames.join(", ")}`
    );
  }

  return { session, inputName, scoresName, boxesName, inputWidth, inputHeight };
}

function tensorMetadata(
  list: readonly ort.InferenceSession.ValueMetadata[] | undefined
): ort.InferenceSession.TensorValueMetadata[] {
  return (list ?? []).filter((m): m is ort.InferenceSession.TensorValueMetadata => m.isTensor);
}

/** True when a real ONNX session is loaded. */
export function isModelLoaded(): boolean {
  return loaded !== null;
}

/** Release the session (e.g. when the extension is suspended). */
export async function disposeModel(): Promise<void> {
  if (loaded) {
    const { session } = loaded;
    loaded = null;
    await session.release();
  }
}

/**
 * The face detector does not find UI elements, so its `uiElements` is always empty (never fake
 * data). Visual UI detection lives in ./ui-detector.ts. Merging its boxes into the element list
 * (for canvas apps, images of buttons, cross-origin iframes the content script cannot see) is
 * the next step; today they are sent alongside as `perception.visualElements`.
 */
export function detectUiElementsPlaceholder(_image: RawImage): UIElement[] {
  return [];
}

/** Output for a step where perception was intentionally skipped (e.g. no screenshot taken). */
export function placeholderOutput(): PerceptionOutput {
  return { modelId: PLACEHOLDER_MODEL_ID, latencyMs: 0, sensitiveRegions: [], uiElements: [] };
}

/**
 * Run the face detector over a decoded screenshot.
 *
 * Throws if no model is loaded: silently returning "no faces" would be a privacy bug, so
 * callers must either load a model or explicitly opt into `placeholderOutput()`.
 */
export async function runInference(image: RawImage): Promise<PerceptionOutput> {
  if (!loaded) {
    throw new Error(
      "runInference: no model loaded. Call loadModel({ modelUrl | modelBytes }) first, or use placeholderOutput() when perception is intentionally skipped."
    );
  }
  const startedAt = performance.now();
  const { session, inputName, scoresName, boxesName, inputWidth, inputHeight } = loaded;

  const inputData = preprocess(image, inputWidth, inputHeight);
  const input = new ort.Tensor("float32", inputData, [1, 3, inputHeight, inputWidth]);
  const outputs = await session.run({ [inputName]: input });

  const scores = outputs[scoresName];
  const boxes = outputs[boxesName];
  if (!scores || !boxes) {
    throw new Error(`runInference: model did not return ${scoresName}/${boxesName}`);
  }

  const numAnchors = Number(scores.dims[1] ?? 0);
  const candidates = decodeUltraFace(
    scores.data as Float32Array,
    boxes.data as Float32Array,
    numAnchors,
    image.width,
    image.height,
    activeConfig.scoreThreshold
  );
  const faces = nms(candidates, activeConfig.iouThreshold, activeConfig.maxDetections);

  return {
    modelId: activeConfig.modelId,
    latencyMs: Math.round(performance.now() - startedAt),
    sensitiveRegions: toSensitiveRegions(faces, "face"),
    uiElements: detectUiElementsPlaceholder(image),
  };
}

/** Exposed for diagnostics (e.g. an options page showing detector status). */
export function getRuntimeInfo(): {
  ortVersion: string;
  config: PerceptionConfig;
  loaded: boolean;
  input: { name: string; width: number; height: number } | null;
} {
  return {
    ortVersion: ort.env.versions.web ?? "unknown",
    config: activeConfig,
    loaded: loaded !== null,
    input: loaded ? { name: loaded.inputName, width: loaded.inputWidth, height: loaded.inputHeight } : null,
  };
}
