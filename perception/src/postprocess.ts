/**
 * Tensor -> boxes. UltraFace's ONNX export already applies softmax and decodes anchors, so the
 * outputs are:
 *   scores: [1, N, 2]  (background, face) probabilities
 *   boxes:  [1, N, 4]  (x1, y1, x2, y2) normalised to [0, 1] of the network input
 * Left to do here: threshold, map to image pixels, hard NMS.
 */
import type { SensitiveCategory } from "@odpa/shared";

import type { SensitiveRegion } from "./types";

export interface Detection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/** Threshold and scale UltraFace outputs to pixel-space detections (unsorted, pre-NMS). */
export function decodeUltraFace(
  scores: Float32Array,
  boxes: Float32Array,
  numAnchors: number,
  imageWidth: number,
  imageHeight: number,
  scoreThreshold: number
): Detection[] {
  const out: Detection[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const score = scores[i * 2 + 1]!;
    if (score < scoreThreshold) continue;
    const b = i * 4;
    const x1 = clamp(boxes[b]! * imageWidth, 0, imageWidth);
    const y1 = clamp(boxes[b + 1]! * imageHeight, 0, imageHeight);
    const x2 = clamp(boxes[b + 2]! * imageWidth, 0, imageWidth);
    const y2 = clamp(boxes[b + 3]! * imageHeight, 0, imageHeight);
    if (x2 - x1 < 1 || y2 - y1 < 1) continue;
    out.push({ x1, y1, x2, y2, score });
  }
  return out;
}

export function iou(a: Detection, b: Detection): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

/** Greedy hard NMS (same as the upstream reference implementation). */
export function nms(detections: Detection[], iouThreshold: number, maxDetections: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const candidate of sorted) {
    if (kept.length >= maxDetections) break;
    if (kept.every((k) => iou(k, candidate) <= iouThreshold)) kept.push(candidate);
  }
  return kept;
}

export function toSensitiveRegions(detections: Detection[], category: SensitiveCategory): SensitiveRegion[] {
  return detections.map((d) => ({
    bbox: {
      x: round1(d.x1),
      y: round1(d.y1),
      width: round1(d.x2 - d.x1),
      height: round1(d.y2 - d.y1),
    },
    category,
    confidence: Math.round(d.score * 1000) / 1000,
    method: "ml" as const,
  }));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
