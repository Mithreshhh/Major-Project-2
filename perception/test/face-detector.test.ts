/**
 * Runs the real UltraFace detector over sample images and prints every box it finds, so the
 * detections can be checked by eye. It also writes annotated copies with green rectangles to
 * test/output/ (git-ignored).
 *
 *   npm test                                   (from perception/)
 *   PERCEPTION_MODEL=version-RFB-320.onnx npm test
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";

import { disposeModel, getRuntimeInfo, isModelLoaded, loadModel, runInference } from "../src/inference";
import type { PerceptionOutput, RawImage, SensitiveRegion } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturesDir = path.join(here, "fixtures");
const outputDir = path.join(here, "output");
const modelFile = process.env.PERCEPTION_MODEL ?? "version-RFB-640.onnx";

interface Sample {
  file: string;
  faces: { min: number; max: number };
  note: string;
  /** Where the centre of the highest-confidence face must fall (pixel ranges), if known. */
  firstFaceCentre?: { x: [number, number]; y: [number, number] };
}

const SAMPLES: Sample[] = [
  {
    file: "astronaut.jpg",
    faces: { min: 1, max: 1 },
    note: "NASA portrait of Eileen Collins (public domain): one clear face, upper centre-left",
    firstFaceCentre: { x: [150, 300], y: [60, 200] },
  },
  {
    file: "apollo11-crew.jpg",
    faces: { min: 3, max: 3 },
    note: "Apollo 11 crew portrait (NASA, public domain): three faces",
  },
  {
    file: "coffee.jpg",
    faces: { min: 0, max: 0 },
    note: "coffee cup (CC0): true negative, nothing face-like",
  },
  {
    file: "chelsea-cat.jpg",
    faces: { min: 0, max: 2 },
    note: "cat photo (CC0): known confuser; human-face detectors often fire on cat faces, which is the safe direction for redaction",
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadJpeg(file: string): Promise<RawImage> {
  const bytes = await readFile(path.join(fixturesDir, file));
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  };
}

function drawBoxes(image: RawImage, regions: SensitiveRegion[], thickness = 3): RawImage {
  const data = new Uint8ClampedArray(image.data);
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const i = (y * image.width + x) * 4;
    data[i] = 0;
    data[i + 1] = 255;
    data[i + 2] = 0;
    data[i + 3] = 255;
  };
  for (const { bbox } of regions) {
    const x1 = Math.round(bbox.x);
    const y1 = Math.round(bbox.y);
    const x2 = Math.round(bbox.x + bbox.width);
    const y2 = Math.round(bbox.y + bbox.height);
    for (let t = 0; t < thickness; t++) {
      for (let x = x1; x <= x2; x++) {
        paint(x, y1 + t);
        paint(x, y2 - t);
      }
      for (let y = y1; y <= y2; y++) {
        paint(x1 + t, y);
        paint(x2 - t, y);
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

async function saveAnnotated(file: string, image: RawImage, regions: SensitiveRegion[]): Promise<string> {
  const annotated = drawBoxes(image, regions);
  const encoded = jpeg.encode(
    { data: Buffer.from(annotated.data.buffer, annotated.data.byteOffset, annotated.data.byteLength), width: image.width, height: image.height },
    90
  );
  const target = path.join(outputDir, file.replace(/\.jpe?g$/i, ".detections.jpg"));
  await writeFile(target, encoded.data);
  return target;
}

function report(sample: Sample, image: RawImage, output: PerceptionOutput, annotatedPath: string): void {
  const lines = [
    "",
    `${sample.file}  ${image.width}x${image.height}  ${sample.note}`,
    `  model=${output.modelId}  latency=${output.latencyMs} ms  faces=${output.sensitiveRegions.length}  uiElements=${output.uiElements.length} (placeholder)`,
  ];
  output.sensitiveRegions.forEach((r, i) => {
    const b = r.bbox;
    lines.push(
      `  face[${i}]  x=${b.x}  y=${b.y}  w=${b.width}  h=${b.height}  confidence=${r.confidence}  (${r.category}/${r.method})`
    );
  });
  lines.push(`  annotated -> ${path.relative(root, annotatedPath)}`);
  console.log(lines.join("\n"));
}

function assertWithinImage(region: SensitiveRegion, image: RawImage): void {
  const b = region.bbox;
  assert.ok(b.x >= 0 && b.y >= 0, `box origin inside image: ${JSON.stringify(b)}`);
  assert.ok(b.x + b.width <= image.width + 0.5 && b.y + b.height <= image.height + 0.5, `box inside image: ${JSON.stringify(b)}`);
  assert.ok(b.width > 4 && b.height > 4, `box has area: ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  const modelPath = path.join(root, "models", modelFile);
  const bytes = new Uint8Array(await readFile(modelPath));
  const ok = await loadModel({
    modelBytes: bytes,
    modelId: modelFile.replace(/\.onnx$/i, "").toLowerCase().replace("version-", "ultraface-"),
    executionProviders: ["wasm"],
    numThreads: 1,
  });
  assert.equal(ok, true, `model failed to load from ${modelPath}`);
  await mkdir(outputDir, { recursive: true });

  const info = getRuntimeInfo();
  console.log(
    `\nloaded ${path.relative(root, modelPath)} (${bytes.byteLength} bytes) with onnxruntime-web ${info.ortVersion}; ` +
      `input ${info.input?.name} ${info.input?.width}x${info.input?.height}; ` +
      `scoreThreshold=${info.config.scoreThreshold} iouThreshold=${info.config.iouThreshold}`
  );
});

after(async () => {
  await disposeModel();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("model is loaded with a 4-D image input", () => {
  assert.ok(isModelLoaded());
  const info = getRuntimeInfo();
  assert.ok(info.input && info.input.width >= 320 && info.input.height >= 240, JSON.stringify(info.input));
});

for (const sample of SAMPLES) {
  test(`${sample.file}: finds ${sample.faces.min === sample.faces.max ? sample.faces.min : `${sample.faces.min}..${sample.faces.max}`} face(s)`, async () => {
    const image = await loadJpeg(sample.file);
    const output = await runInference(image);
    const annotated = await saveAnnotated(sample.file, image, output.sensitiveRegions);
    report(sample, image, output, annotated);

    // Shape contract: sensitiveRegions look like wire RedactedRegions, uiElements is an empty placeholder.
    const threshold = getRuntimeInfo().config.scoreThreshold;
    assert.deepEqual(output.uiElements, []);
    assert.equal(output.modelId.startsWith("ultraface-"), true);
    for (const region of output.sensitiveRegions) {
      assert.equal(region.category, "face");
      assert.equal(region.method, "ml");
      assert.ok(region.confidence >= threshold && region.confidence <= 1, `confidence in range: ${region.confidence}`);
      assertWithinImage(region, image);
    }

    const n = output.sensitiveRegions.length;
    assert.ok(
      n >= sample.faces.min && n <= sample.faces.max,
      `${sample.file}: expected ${sample.faces.min}..${sample.faces.max} face(s), got ${n}`
    );

    if (sample.firstFaceCentre) {
      const best = [...output.sensitiveRegions].sort((a, b) => b.confidence - a.confidence)[0]!;
      const cx = best.bbox.x + best.bbox.width / 2;
      const cy = best.bbox.y + best.bbox.height / 2;
      const { x, y } = sample.firstFaceCentre;
      assert.ok(cx >= x[0] && cx <= x[1] && cy >= y[0] && cy <= y[1], `face centre (${cx}, ${cy}) outside expected region x=${x} y=${y}`);
    }
  });
}

test("detections are data-dependent, not canned: a flat grey image yields no faces", async () => {
  const width = 640;
  const height = 480;
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const output = await runInference({ width, height, data });
  console.log(`\nflat grey ${width}x${height}: faces=${output.sensitiveRegions.length} latency=${output.latencyMs} ms`);
  assert.equal(output.sensitiveRegions.length, 0);
});

test("the portrait's face is still found after downscaling the image by half", async () => {
  const original = await loadJpeg("astronaut.jpg");
  const { resizeForModel } = await import("../src/preprocess");
  const small = resizeForModel(original, Math.round(original.width / 2), Math.round(original.height / 2));
  const output = await runInference(small);
  console.log(
    `\nastronaut at ${small.width}x${small.height}: faces=${output.sensitiveRegions.length} ` +
      output.sensitiveRegions.map((r) => `[x=${r.bbox.x} y=${r.bbox.y} w=${r.bbox.width} h=${r.bbox.height} c=${r.confidence}]`).join(" ")
  );
  assert.equal(output.sensitiveRegions.length, 1);
  const box = output.sensitiveRegions[0]!.bbox;
  // Box should scale with the image: roughly half the size of the full-resolution detection.
  assert.ok(box.width < original.width / 2 && box.height < original.height / 2);
});
