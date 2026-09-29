/**
 * Runs the trained UI detector (models/ui-detect.onnx) through the same TypeScript path the
 * extension uses, on screenshots of the demo page that were NOT used in training, and scores it
 * against the DOM boxes of those screenshots (fixtures/ui/*.txt, YOLO format). Annotated copies
 * go to test/output/ (red = button, blue = input, green = link).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { UIElement } from "@odpa/shared";
import jpeg from "jpeg-js";

import { configureRuntime } from "../src/inference";
import type { RawImage } from "../src/types";
import { UI_CLASSES, compareWithDom, detectUiElements, loadUiDetector, type UiDetection } from "../src/ui-detector";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "ui");
const outputDir = path.join(here, "output");
const modelPath = path.resolve(here, "..", "models", "ui-detect.onnx");

const SAMPLES = [
  { file: "demo_00_1280x720_empty.jpg", note: "demo page, 1280x720, empty form (held out)" },
  { file: "demo_10_1920x1080_filled.jpg", note: "demo page, 1920x1080, filled form (held out)" },
  { file: "demo_20_800x900_scrolled.jpg", note: "demo page, 800x900 narrow layout, scrolled (held out)" },
  { file: "page_1550.jpg", note: "synthetic validation page (not trained on)" },
];

const ROLE_OF_CLASS: UIElement["role"][] = ["button", "textbox", "link"];
const COLORS: Array<[number, number, number]> = [[230, 40, 40], [30, 140, 255], [20, 170, 60]];

async function loadJpeg(file: string): Promise<RawImage> {
  const decoded = jpeg.decode(await readFile(path.join(fixturesDir, file)), { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
}

/** YOLO label file -> DOM-like ground truth elements in pixels. */
async function loadTruth(file: string, image: RawImage): Promise<UIElement[]> {
  const text = await readFile(path.join(fixturesDir, file.replace(/\.jpg$/, ".txt")), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line, i) => {
    const [c, cx, cy, w, h] = line.split(" ").map(Number) as [number, number, number, number, number];
    return {
      id: `gt_${i}`,
      role: ROLE_OF_CLASS[c]!,
      label: "",
      bbox: { x: (cx - w / 2) * image.width, y: (cy - h / 2) * image.height, width: w * image.width, height: h * image.height },
      isVisible: true,
      isInteractive: true,
    };
  });
}

async function saveAnnotated(file: string, image: RawImage, detections: UiDetection[]): Promise<string> {
  const data = new Uint8ClampedArray(image.data);
  const paint = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const i = (y * image.width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  };
  for (const d of detections) {
    const color = COLORS[UI_CLASSES.indexOf(d.role)]!;
    const x1 = Math.round(d.bbox.x), y1 = Math.round(d.bbox.y);
    const x2 = Math.round(d.bbox.x + d.bbox.width), y2 = Math.round(d.bbox.y + d.bbox.height);
    for (let t = 0; t < 2; t++) {
      for (let x = x1; x <= x2; x++) { paint(x, y1 + t, color); paint(x, y2 - t, color); }
      for (let y = y1; y <= y2; y++) { paint(x1 + t, y, color); paint(x2 - t, y, color); }
    }
  }
  const target = path.join(outputDir, file.replace(/\.jpg$/, ".ui.jpg"));
  await writeFile(target, jpeg.encode({ data: Buffer.from(data.buffer), width: image.width, height: image.height }, 90).data);
  return target;
}

const hasModel = existsSync(modelPath);

before(async () => {
  if (!hasModel) return;
  configureRuntime({ numThreads: 1 });
  await mkdir(outputDir, { recursive: true });
  assert.equal(await loadUiDetector({ modelBytes: new Uint8Array(await readFile(modelPath)) }), true);
});

for (const sample of SAMPLES) {
  test(`UI detector finds buttons, inputs and links: ${sample.file}`, { skip: !hasModel && "models/ui-detect.onnx not built" }, async () => {
    const image = await loadJpeg(sample.file);
    const truth = await loadTruth(sample.file, image);
    const out = await detectUiElements(image);
    const cmp = compareWithDom(out.detections, truth, 1, { width: image.width, height: image.height });
    const annotated = await saveAnnotated(sample.file, image, out.detections);

    const byRole = (role: string) => `${out.detections.filter((d) => d.role === role).length}`;
    console.log(
      `\n${sample.file}  ${image.width}x${image.height}  ${sample.note}\n` +
        `  model=${out.modelId}  latency=${out.latencyMs} ms  detections=${out.detections.length} ` +
        `(button ${byRole("button")}, input ${byRole("textbox")}, link ${byRole("link")})\n` +
        `  vs DOM: found ${cmp.found}/${cmp.domCount} (recall ${cmp.recall}), ${cmp.correct}/${out.detections.length} correct (precision ${cmp.precision})\n` +
        `  annotated -> ${path.relative(path.resolve(here, ".."), annotated)}`
    );

    assert.ok(cmp.recall >= 0.8, `recall ${cmp.recall} below 0.8`);
    assert.ok(cmp.precision >= 0.8, `precision ${cmp.precision} below 0.8`);
  });
}
