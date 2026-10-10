/**
 * On-device OCR (PaddleOCR PP-OCRv3 English through ONNX Runtime Web, the path the extension
 * runs): decoding and box-finding on synthetic input, then the real models on a screenshot of
 * the test site's embedded payment frame (fixtures/ocr/pay-frame.jpg), whose text the extension
 * cannot read from the page code.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";

import { configureRuntime } from "../src/inference";
import { EN_DICT, boxesFromProbabilityMap, ctcDecode, loadOcr, readText } from "../src/ocr";
import { sensitiveOcrText } from "../src/pii";
import type { RawImage } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const models = path.resolve(here, "..", "models");
const detPath = path.join(models, "ocr-det-en-v3.onnx");
const recPath = path.join(models, "ocr-rec-en-v3.onnx");
const hasModels = existsSync(detPath) && existsSync(recPath);

test("the dictionary matches PaddleOCR's en_dict.txt: 95 distinct characters ending in a space", () => {
  assert.equal(EN_DICT.length, 95);
  assert.equal(new Set(EN_DICT).size, 95);
  assert.equal(EN_DICT.at(-1), " ");
  assert.ok(EN_DICT.startsWith("0123456789:;<=>?@ABC"));
});

test("CTC decoding collapses repeats and drops blanks", () => {
  // Classes: 0 blank, then EN_DICT ("0" is class 1, "1" is class 2), then the extra space.
  const classes = EN_DICT.length + 2;
  const steps = [2, 2, 0, 2, 1, 1, 0, 0]; // "1", "1" repeated, blank, "1", "0", "0" repeated
  const scores = new Float32Array(steps.length * classes);
  steps.forEach((c, t) => (scores[t * classes + c] = 0.9));
  assert.deepEqual(ctcDecode(scores, steps.length, classes), { text: "110", confidence: 0.8999999761581421 });
});

test("text boxes from a probability map: one per blob, weak blobs dropped, grown back by the unclip distance", () => {
  const w = 40, h = 20;
  const prob = new Float32Array(w * h);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * w + x] = v;
  };
  fill(5, 5, 21, 9, 0.9); //    a confident line
  fill(24, 14, 38, 18, 0.4); // above the pixel threshold, below the box threshold
  const boxes = boxesFromProbabilityMap(prob, w, h, { binaryThreshold: 0.3, boxThreshold: 0.6, unclipRatio: 1.5 });
  assert.equal(boxes.length, 1);
  const d = (16 * 4 * 1.5) / (2 * (16 + 4)); // DB unclip: area * ratio / perimeter
  assert.deepEqual(boxes[0], { x1: 5 - d, y1: 5 - d, x2: 21 + d, y2: 9 + d, score: 0.8999999761581421 });
});

test("text read from pixels is judged strictly: an OCR slip in a card number still counts", () => {
  assert.equal(sensitiveOcrText("4111 1111 1111 1111"), "payment_card");
  assert.equal(sensitiveOcrText("41111111 1111 1112"), "pii_text"); // misread: fails Luhn, still hidden
  assert.equal(sensitiveOcrText("jane.doe@example.com"), "email");
  assert.equal(sensitiveOcrText("jane.doe @ example.com"), "email");
  assert.equal(sensitiveOcrText("+91 98765 43210"), "phone");
  for (const harmless of ["Card number", "08/29", "Pay 711,788", "Saved details - secure payment"]) {
    assert.equal(sensitiveOcrText(harmless), null, harmless);
  }
});

before(async () => {
  if (!hasModels) return;
  configureRuntime({ numThreads: 1 });
  assert.equal(
    await loadOcr({ detModelBytes: new Uint8Array(await readFile(detPath)), recModelBytes: new Uint8Array(await readFile(recPath)) }),
    true
  );
});

test("OCR reads an embedded payment frame and finds its personal data", { skip: !hasModels && "OCR models not in perception/models" }, async () => {
  const decoded = jpeg.decode(await readFile(path.join(here, "fixtures", "ocr", "pay-frame.jpg")), { useTArray: true, formatAsRGBA: true });
  const image: RawImage = { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
  const out = await readText(image);
  const texts = out.lines.map((l) => l.text);
  console.log(`\npay-frame.jpg ${image.width}x${image.height}: ${out.lines.length} lines in ${out.latencyMs} ms\n  ${texts.join(" | ")}`);

  for (const expected of ["PayEase", "Card holder", "Card number", "Receipt to", "Phone", "jane.doe@example.com", "+91 98765 43210"]) {
    assert.ok(texts.includes(expected), `read "${expected}": ${JSON.stringify(texts)}`);
  }
  const flagged = out.lines.filter((l) => sensitiveOcrText(l.text)).map((l) => l.text);
  assert.equal(flagged.length, 3, `card, email and phone are flagged, nothing else: ${JSON.stringify(flagged)}`);
  assert.ok(flagged.some((t) => t.replace(/\s/g, "").includes("4111111111111")), `card line: ${JSON.stringify(flagged)}`);
  for (const l of out.lines) {
    assert.ok(l.bbox.x >= 0 && l.bbox.y >= 0 && l.bbox.x + l.bbox.width <= image.width + 1 && l.bbox.y + l.bbox.height <= image.height + 1);
  }
});
