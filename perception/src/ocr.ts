/**
 * On-device OCR: reads text from screenshot pixels, for the places the page code cannot describe
 * (embedded frames, canvases, images of buttons).
 *
 * Models: PaddleOCR PP-OCRv3 English (Apache-2.0), ONNX conversions from RapidOCR.
 *   detection    en_PP-OCRv3_det_infer.onnx  input [1, 3, H, W] (BGR, ImageNet mean/std, sides
 *                multiples of 32), output [1, 1, H, W]: per-pixel probability of "text here"
 *                (DB, Differentiable Binarization)
 *   recognition  en_PP-OCRv3_rec_infer.onnx  input [1, 3, 48, W] (BGR, scaled to -1..1), output
 *                [1, T, 97]: per time step, blank + 95 characters of EN_DICT + space (CTC)
 *
 * Shares the ONNX Runtime set-up done by `configureRuntime()` in ./inference. Text never leaves
 * this module except as returned values; callers decide what may leave the device.
 */
import type { BoundingBox } from "@odpa/shared";
import * as ort from "onnxruntime-web";

import { resizeBilinear } from "./preprocess";
import type { RawImage } from "./types";

/** PaddleOCR's ppocr/utils/en_dict.txt, in order (its last line is a space). */
export const EN_DICT = "0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~!\"#$%&'()*+,-./ ";

export interface OcrConfig {
  detModelUrl?: string | null;
  detModelBytes?: Uint8Array;
  recModelUrl?: string | null;
  recModelBytes?: Uint8Array;
  modelId: string;
  /** Longest side fed to the detector; larger regions are shrunk. */
  maxSide: number;
  /** Regions smaller than this (longest side) are enlarged first: small screen text detects better. */
  minSide: number;
  /** Probability above which a pixel counts as text. */
  binaryThreshold: number;
  /** Mean probability a text box needs to be kept. */
  boxThreshold: number;
  /** How far a detected (shrunk) text kernel is grown back to the full line, as in DB. */
  unclipRatio: number;
  /** Mean character confidence a recognised line needs to be kept. */
  minTextConfidence: number;
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  modelId: "ppocr-v3-en",
  maxSide: 960,
  minSide: 640,
  binaryThreshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.6,
  minTextConfidence: 0.5,
};

/** One line of text, in the pixel space of the image it was read from. */
export interface TextLine {
  bbox: BoundingBox;
  text: string;
  /** 0..1 mean character confidence. */
  confidence: number;
}

export interface OcrOutput {
  modelId: string;
  latencyMs: number;
  lines: TextLine[];
}

interface LoadedOcr {
  det: ort.InferenceSession;
  rec: ort.InferenceSession;
}

let loaded: LoadedOcr | null = null;
let config: OcrConfig = DEFAULT_OCR_CONFIG;

/** Load both OCR models. Returns false when either model source is missing. */
export async function loadOcr(partial: Partial<OcrConfig> = {}): Promise<boolean> {
  config = { ...DEFAULT_OCR_CONFIG, ...partial };
  if (loaded) {
    await Promise.all([loaded.det.release(), loaded.rec.release()]);
    loaded = null;
  }
  const detSource = config.detModelBytes ?? config.detModelUrl;
  const recSource = config.recModelBytes ?? config.recModelUrl;
  if (!detSource || !recSource) return false;

  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  const create = (source: string | Uint8Array) =>
    typeof source === "string" ? ort.InferenceSession.create(source, options) : ort.InferenceSession.create(source, options);
  const [det, rec] = await Promise.all([create(detSource), create(recSource)]);
  loaded = { det, rec };
  return true;
}

export function isOcrLoaded(): boolean {
  return loaded !== null;
}

/** Integer crop of `image` to `box` (clamped to the image). */
export function cropImage(image: RawImage, box: BoundingBox): RawImage {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** RGBA -> BGR CHW float32 with per-channel (v / 255 - mean) / std. */
function toBgrChw(image: RawImage, mean: readonly number[], std: readonly number[]): Float32Array {
  const plane = image.width * image.height;
  const out = new Float32Array(3 * plane);
  const src = image.data;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = (src[p + 2]! / 255 - mean[0]!) / std[0]!;
    out[plane + i] = (src[p + 1]! / 255 - mean[1]!) / std[1]!;
    out[2 * plane + i] = (src[p]! / 255 - mean[2]!) / std[2]!;
  }
  return out;
}

const roundTo32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/**
 * Text boxes from a DB probability map: threshold, connected components (4-neighbour), keep
 * components whose mean probability is high enough, then grow each box back by the DB unclip
 * distance (area * ratio / perimeter). Boxes are in map pixels.
 */
export function boxesFromProbabilityMap(
  prob: Float32Array,
  width: number,
  height: number,
  { binaryThreshold, boxThreshold, unclipRatio }: Pick<OcrConfig, "binaryThreshold" | "boxThreshold" | "unclipRatio">
): Array<{ x1: number; y1: number; x2: number; y2: number; score: number }> {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; score: number }> = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start]! <= binaryThreshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0, sum = 0, count = 0;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      sum += prob[i]!;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const push = (j: number) => {
        if (!seen[j] && prob[j]! > binaryThreshold) {
          seen[j] = 1;
          stack[top++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < 3 || h < 3 || sum / count < boxThreshold) continue;
    const d = (w * h * unclipRatio) / (2 * (w + h));
    out.push({
      x1: Math.max(0, minX - d),
      y1: Math.max(0, minY - d),
      x2: Math.min(width, maxX + 1 + d),
      y2: Math.min(height, maxY + 1 + d),
      score: sum / count,
    });
  }
  return out;
}

/** Text line boxes inside `region` of `image` (default: all of it), in image pixels. */
export async function detectTextLines(image: RawImage, region?: BoundingBox): Promise<BoundingBox[]> {
  if (!loaded) throw new Error("detectTextLines: no OCR model loaded. Call loadOcr() first.");
  const area = region ?? { x: 0, y: 0, width: image.width, height: image.height };
  const crop = cropImage(image, area);
  const longest = Math.max(crop.width, crop.height);
  const scale = longest > config.maxSide ? config.maxSide / longest : longest < config.minSide ? Math.min(2, config.minSide / longest) : 1;
  const dw = roundTo32(crop.width * scale);
  const dh = roundTo32(crop.height * scale);
  const input = toBgrChw(resizeBilinear(crop, dw, dh), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);

  const out = await loaded.det.run({ [loaded.det.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, dh, dw]) });
  const map = out[loaded.det.outputNames[0]!];
  if (!map) throw new Error("detectTextLines: detector returned no output");
  const mh = Number(map.dims[2]);
  const mw = Number(map.dims[3]);
  const sx = crop.width / mw;
  const sy = crop.height / mh;
  const ox = Math.max(0, Math.floor(area.x));
  const oy = Math.max(0, Math.floor(area.y));
  return boxesFromProbabilityMap(map.data as Float32Array, mw, mh, config)
    .map((b) => ({ x: ox + b.x1 * sx, y: oy + b.y1 * sy, width: (b.x2 - b.x1) * sx, height: (b.y2 - b.y1) * sy }))
    .sort((a, b) => Math.round((a.y + a.height / 2) / 8) - Math.round((b.y + b.height / 2) / 8) || a.x - b.x);
}

/** CTC greedy decode of a [T, C] score matrix: best class per step, repeats collapsed, blanks (0) dropped. */
export function ctcDecode(scores: Float32Array, steps: number, classes: number, dict: string = EN_DICT + " "): { text: string; confidence: number } {
  let text = "";
  let confidenceSum = 0;
  let kept = 0;
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < classes; c++) {
      const s = scores[t * classes + c]!;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      text += dict[best - 1] ?? "";
      confidenceSum += bestScore;
      kept += 1;
    }
    previous = best;
  }
  return { text: text.trim(), confidence: kept ? confidenceSum / kept : 0 };
}

/** Read one line of text from `box` of `image` (image pixels). */
export async function recognizeLine(image: RawImage, box: BoundingBox): Promise<{ text: string; confidence: number }> {
  if (!loaded) throw new Error("recognizeLine: no OCR model loaded. Call loadOcr() first.");
  const crop = cropImage(image, box);
  const height = 48;
  const width = Math.max(16, Math.min(2048, Math.ceil((height * crop.width) / crop.height)));
  const input = toBgrChw(resizeBilinear(crop, width, height), [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const out = await loaded.rec.run({ [loaded.rec.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, height, width]) });
  const scores = out[loaded.rec.outputNames[0]!];
  if (!scores) throw new Error("recognizeLine: recogniser returned no output");
  const classes = Number(scores.dims[2]);
  if (classes !== EN_DICT.length + 2) throw new Error(`recognizeLine: model has ${classes} classes, dictionary expects ${EN_DICT.length + 2}`);
  return ctcDecode(scores.data as Float32Array, Number(scores.dims[1]), classes);
}

/** Detect and read every line of text in `region` (default: the whole image). Image pixels. */
export async function readText(image: RawImage, region?: BoundingBox): Promise<OcrOutput> {
  const started = performance.now();
  const lines: TextLine[] = [];
  for (const bbox of await detectTextLines(image, region)) {
    const { text, confidence } = await recognizeLine(image, bbox);
    if (text && confidence >= config.minTextConfidence) lines.push({ bbox: round(bbox), text, confidence: Math.round(confidence * 1000) / 1000 });
  }
  return { modelId: config.modelId, latencyMs: Math.round(performance.now() - started), lines };
}

function round(b: BoundingBox): BoundingBox {
  const r = (v: number) => Math.round(v * 10) / 10;
  return { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) };
}
