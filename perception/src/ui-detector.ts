/**
 * On-device UI-element detection: buttons, inputs and links found from pixels alone.
 *
 * Model: YOLO11n (Ultralytics, AGPL-3.0) fine-tuned by ../ui-model/train.py on synthetic web
 * pages whose labels come for free from the DOM (../ui-model/generate.mjs). Exported to ONNX with
 * input [1, 3, 640, 640] (RGB, 0..1, letterboxed with grey 114) and output [1, 4 + C, N]: per
 * anchor, box centre/size in input pixels followed by C sigmoid class scores. No NMS in the graph.
 *
 * Shares the ONNX Runtime set-up done by `configureRuntime()` in ./inference.
 */
import type { BoundingBox, UIElement, VisualElement } from "@odpa/shared";
import * as ort from "onnxruntime-web";

import { type Detection, iou, nms } from "./postprocess";
import { resizeForModel } from "./preprocess";
import type { RawImage } from "./types";

/** Class order used in training (see ../ui-model/generate.mjs CLASSES). */
export const UI_CLASSES = ["button", "textbox", "link"] as const;
export type UiClass = (typeof UI_CLASSES)[number];

export interface UiDetectorConfig {
  modelUrl?: string | null;
  modelBytes?: Uint8Array;
  modelId: string;
  scoreThreshold: number;
  iouThreshold: number;
  maxDetections: number;
}

export const DEFAULT_UI_DETECTOR_CONFIG: UiDetectorConfig = {
  modelUrl: null,
  modelId: "ui-detect-yolo11n",
  scoreThreshold: 0.5,
  iouThreshold: 0.5,
  maxDetections: 200,
};

/** A detection in screenshot pixel space. */
export interface UiDetection {
  role: UiClass;
  bbox: BoundingBox;
  confidence: number;
}

export interface UiDetectionOutput {
  modelId: string;
  latencyMs: number;
  detections: UiDetection[];
}

interface LoadedUiModel {
  session: ort.InferenceSession;
  inputName: string;
  outputName: string;
  size: number;
}

let loaded: LoadedUiModel | null = null;
let config: UiDetectorConfig = DEFAULT_UI_DETECTOR_CONFIG;

/** Load the UI detector. Returns false when no model source is configured. */
export async function loadUiDetector(partial: Partial<UiDetectorConfig> = {}): Promise<boolean> {
  config = { ...DEFAULT_UI_DETECTOR_CONFIG, ...partial };
  if (loaded) {
    await loaded.session.release();
    loaded = null;
  }
  const source = config.modelBytes ?? config.modelUrl;
  if (!source) return false;

  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  const session =
    typeof source === "string"
      ? await ort.InferenceSession.create(source, options)
      : await ort.InferenceSession.create(source, options);

  const input = session.inputMetadata.find((m) => m.isTensor) as ort.InferenceSession.TensorValueMetadata | undefined;
  const dim = input?.shape[2];
  loaded = {
    session,
    inputName: session.inputNames[0]!,
    outputName: session.outputNames[0]!,
    size: typeof dim === "number" && dim > 0 ? dim : 640,
  };
  return true;
}

export function isUiDetectorLoaded(): boolean {
  return loaded !== null;
}

interface Letterbox {
  data: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

/** Aspect-preserving resize into a size x size grey canvas, as Ultralytics does in training. */
export function letterbox(image: RawImage, size: number): Letterbox {
  const scale = Math.min(size / image.width, size / image.height);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const padX = Math.round((size - w) / 2 - 0.1);
  const padY = Math.round((size - h) / 2 - 0.1);
  const resized = resizeForModel(image, w, h);

  const plane = size * size;
  const data = new Float32Array(3 * plane).fill(114 / 255);
  const src = resized.data;
  for (let y = 0; y < h; y++) {
    let p = y * w * 4;
    let o = (y + padY) * size + padX;
    for (let x = 0; x < w; x++, p += 4, o++) {
      data[o] = src[p]! / 255;
      data[plane + o] = src[p + 1]! / 255;
      data[2 * plane + o] = src[p + 2]! / 255;
    }
  }
  return { data, scale, padX, padY };
}

/** Decode [1, 4 + C, N] YOLO output into per-class detections in image pixels (pre-NMS). */
export function decodeYolo(
  output: Float32Array,
  numClasses: number,
  numAnchors: number,
  lb: Pick<Letterbox, "scale" | "padX" | "padY">,
  imageWidth: number,
  imageHeight: number,
  scoreThreshold: number
): Array<Detection & { cls: number }> {
  const out: Array<Detection & { cls: number }> = [];
  for (let i = 0; i < numAnchors; i++) {
    let best = 0;
    let cls = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = output[(4 + c) * numAnchors + i]!;
      if (s > best) {
        best = s;
        cls = c;
      }
    }
    if (best < scoreThreshold) continue;
    const cx = (output[i]! - lb.padX) / lb.scale;
    const cy = (output[numAnchors + i]! - lb.padY) / lb.scale;
    const w = output[2 * numAnchors + i]! / lb.scale;
    const h = output[3 * numAnchors + i]! / lb.scale;
    const x1 = Math.max(0, cx - w / 2);
    const y1 = Math.max(0, cy - h / 2);
    const x2 = Math.min(imageWidth, cx + w / 2);
    const y2 = Math.min(imageHeight, cy + h / 2);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    out.push({ x1, y1, x2, y2, score: best, cls });
  }
  return out;
}

/** Run the UI detector over a decoded screenshot. Throws if no model is loaded. */
export async function detectUiElements(image: RawImage): Promise<UiDetectionOutput> {
  if (!loaded) throw new Error("detectUiElements: no UI model loaded. Call loadUiDetector() first.");
  const startedAt = performance.now();
  const { session, inputName, outputName, size } = loaded;

  const lb = letterbox(image, size);
  const outputs = await session.run({ [inputName]: new ort.Tensor("float32", lb.data, [1, 3, size, size]) });
  const output = outputs[outputName];
  if (!output) throw new Error(`detectUiElements: model did not return ${outputName}`);
  const numClasses = Number(output.dims[1]) - 4;
  const numAnchors = Number(output.dims[2]);

  const candidates = decodeYolo(
    output.data as Float32Array, numClasses, numAnchors, lb, image.width, image.height, config.scoreThreshold
  );
  const detections: UiDetection[] = [];
  for (let c = 0; c < numClasses; c++) {
    const kept = nms(candidates.filter((d) => d.cls === c), config.iouThreshold, config.maxDetections);
    for (const d of kept) {
      detections.push({
        role: UI_CLASSES[c] ?? "button",
        bbox: { x: round1(d.x1), y: round1(d.y1), width: round1(d.x2 - d.x1), height: round1(d.y2 - d.y1) },
        confidence: Math.round(d.score * 1000) / 1000,
      });
    }
  }
  detections.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  return { modelId: config.modelId, latencyMs: Math.round(performance.now() - startedAt), detections };
}

/** Which vision class a DOM role counts as. Roles outside the three classes are not compared. */
export function domRoleToUiClass(role: UIElement["role"]): UiClass | null {
  if (role === "button") return "button";
  if (role === "link") return "link";
  if (role === "textbox" || role === "checkbox" || role === "radio" || role === "select") return "textbox";
  return null;
}

export interface DomComparison {
  /** Vision boxes (CSS px) annotated with the DOM element they matched. */
  visual: VisualElement[];
  /** DOM elements of a comparable role inside the viewport. */
  domCount: number;
  /** DOM elements found by vision (IoU >= threshold, same class). */
  found: number;
  /** Vision boxes that match a DOM element of the same class. */
  correct: number;
  recall: number;
  precision: number;
}

/**
 * Compare vision detections (screenshot pixels) with the DOM snapshot (CSS pixels): the DOM is
 * ground truth, so this measures the vision model live on every page.
 */
export function compareWithDom(
  detections: UiDetection[],
  elements: UIElement[],
  devicePixelRatio: number,
  viewport: { width: number; height: number },
  iouThreshold = 0.5
): DomComparison {
  const toBox = (b: BoundingBox): Detection => ({ x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height, score: 1 });
  const dom = elements.filter((e) => {
    if (!e.isVisible || !domRoleToUiClass(e.role)) return false;
    const b = e.bbox;
    return b.width >= 4 && b.height >= 4 && b.x < viewport.width && b.y < viewport.height && b.x + b.width > 0 && b.y + b.height > 0;
  });
  const visual: VisualElement[] = detections.map((d) => ({
    role: d.role,
    bbox: {
      x: round1(d.bbox.x / devicePixelRatio),
      y: round1(d.bbox.y / devicePixelRatio),
      width: round1(d.bbox.width / devicePixelRatio),
      height: round1(d.bbox.height / devicePixelRatio),
    },
    confidence: d.confidence,
  }));

  const usedDom = new Set<string>();
  let correct = 0;
  // Greedy, most confident first, one DOM element per vision box.
  const order = visual.map((_, i) => i).sort((a, b) => visual[b]!.confidence - visual[a]!.confidence);
  for (const i of order) {
    const v = visual[i]!;
    let bestId: string | undefined;
    let bestIou = iouThreshold;
    for (const e of dom) {
      if (usedDom.has(e.id) || domRoleToUiClass(e.role) !== v.role) continue;
      const o = iou(toBox(v.bbox), toBox(e.bbox));
      if (o >= bestIou) {
        bestIou = o;
        bestId = e.id;
      }
    }
    if (bestId) {
      usedDom.add(bestId);
      v.matchedId = bestId;
      correct += 1;
    }
  }
  const found = usedDom.size;
  return {
    visual,
    domCount: dom.length,
    found,
    correct,
    recall: dom.length ? round3(found / dom.length) : 1,
    precision: visual.length ? round3(correct / visual.length) : 1,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
