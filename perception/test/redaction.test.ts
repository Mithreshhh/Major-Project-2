/**
 * Runs the real face detector over fixture images, feeds the detections into redact(), and
 * writes the masked images to test/output/*.redacted.jpg so the black boxes can be checked by
 * eye. Also proves the mask is complete: the detector finds nothing in the redacted image.
 *
 *   npm test        (from perception/)
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";

import { disposeModel, loadModel, runInference } from "../src/inference";
import { DEFAULT_REDACT_OPTIONS, padRegion, redact, sanitize, toCssPixels } from "../src/redaction";
import type { RawImage, SensitiveRegion } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturesDir = path.join(here, "fixtures");
const outputDir = path.join(here, "output");
const modelFile = process.env.PERCEPTION_MODEL ?? "version-RFB-640.onnx";

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

async function saveJpeg(name: string, image: RawImage): Promise<string> {
  const encoded = jpeg.encode(
    { data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), width: image.width, height: image.height },
    90
  );
  const target = path.join(outputDir, name);
  await writeFile(target, encoded.data);
  return target;
}

function pixel(image: RawImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, image.data[i + 3]!];
}

function inside(x: number, y: number, regions: readonly SensitiveRegion[]): boolean {
  return regions.some(({ bbox }) => x >= bbox.x && x < bbox.x + bbox.width && y >= bbox.y && y < bbox.y + bbox.height);
}

/** Every pixel inside the masked boxes is opaque black; every pixel outside equals the original. */
function assertMaskExact(original: RawImage, redacted: RawImage, masked: readonly SensitiveRegion[]): void {
  let insideCount = 0;
  let outsideCount = 0;
  for (let y = 0; y < original.height; y++) {
    for (let x = 0; x < original.width; x++) {
      const i = (y * original.width + x) * 4;
      if (inside(x, y, masked)) {
        insideCount++;
        if (redacted.data[i] !== 0 || redacted.data[i + 1] !== 0 || redacted.data[i + 2] !== 0 || redacted.data[i + 3] !== 255) {
          assert.fail(`pixel (${x}, ${y}) inside a masked region is not opaque black: ${pixel(redacted, x, y)}`);
        }
      } else {
        outsideCount++;
        for (let c = 0; c < 4; c++) {
          if (redacted.data[i + c] !== original.data[i + c]) {
            assert.fail(`pixel (${x}, ${y}) outside every masked region was altered`);
          }
        }
      }
    }
  }
  assert.ok(insideCount > 0, "mask covers at least one pixel");
  assert.ok(outsideCount > 0, "mask does not cover the whole image");
}

function describe(label: string, regions: readonly SensitiveRegion[]): string {
  return regions
    .map((r, i) => `  ${label}[${i}]  x=${r.bbox.x}  y=${r.bbox.y}  w=${r.bbox.width}  h=${r.bbox.height}  conf=${r.confidence}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  const bytes = new Uint8Array(await readFile(path.join(root, "models", modelFile)));
  assert.equal(await loadModel({ modelBytes: bytes, modelId: "ultraface-test", executionProviders: ["wasm"], numThreads: 1 }), true);
  await mkdir(outputDir, { recursive: true });
});

after(async () => {
  await disposeModel();
});

// ---------------------------------------------------------------------------
// unit: padding
// ---------------------------------------------------------------------------

test("padRegion grows a box by at least 15% per side and snaps outward to whole pixels", () => {
  const padded = padRegion({ x: 100.4, y: 50.6, width: 80, height: 100 }, 1000, 1000);
  assert.ok(padded);
  // 15% of 80 = 12 -> x from 88.4 floored to 88; right edge 180.4 + 12 = 192.4 ceil 193
  assert.deepEqual(padded, { x: 88, y: 35, width: 105, height: 131 });
  assert.ok(padded.x <= 100.4 - 12 && padded.x + padded.width >= 180.4 + 12);
  assert.ok(padded.y <= 50.6 - 15 && padded.y + padded.height >= 150.6 + 15);
});

test("padRegion clamps to the image and applies the minimum margin to tiny boxes", () => {
  assert.deepEqual(padRegion({ x: 2, y: 3, width: 10, height: 10 }, 640, 480), { x: 0, y: 0, width: 16, height: 17 });
  assert.deepEqual(padRegion({ x: 630, y: 470, width: 20, height: 20 }, 640, 480), { x: 626, y: 466, width: 14, height: 14 });
  assert.equal(padRegion({ x: 700, y: 10, width: 20, height: 20 }, 640, 480), null);
  assert.equal(DEFAULT_REDACT_OPTIONS.padding, 0.15);
});

// ---------------------------------------------------------------------------
// unit: buffer semantics
// ---------------------------------------------------------------------------

test("redact() with no regions returns the same object and touches nothing", async () => {
  const image = await loadJpeg("coffee.jpg");
  const before = new Uint8ClampedArray(image.data);
  const result = redact(image, [], { wipeSource: true });
  assert.equal(result.image, image);
  assert.equal(result.changed, false);
  assert.deepEqual(result.masked, []);
  assert.deepEqual(image.data, before, "source untouched even with wipeSource when nothing was masked");
});

test("redact() returns a fresh buffer and leaves the source intact unless wipeSource is set", async () => {
  const image = await loadJpeg("astronaut.jpg");
  const before = new Uint8ClampedArray(image.data);
  const region: SensitiveRegion = { bbox: { x: 179, y: 52, width: 90, height: 122 }, category: "face", confidence: 1, method: "ml" };

  const kept = redact(image, [region]);
  assert.notEqual(kept.image, image);
  assert.notEqual(kept.image.data, image.data);
  assert.notEqual(kept.image.data.buffer, image.data.buffer);
  assert.deepEqual(image.data, before, "source buffer not modified");
  assert.equal(kept.changed, true);

  const wiped = redact(image, [region], { wipeSource: true });
  assert.equal(wiped.changed, true);
  assert.ok(image.data.every((v) => v === 0), "source buffer zeroed after wipeSource");
  assert.ok(wiped.image.data.some((v) => v !== 0), "masked copy still holds the rest of the picture");
});

// ---------------------------------------------------------------------------
// end to end: real detector -> redact -> saved image -> detector finds nothing
// ---------------------------------------------------------------------------

for (const { file, minFaces } of [
  { file: "astronaut.jpg", minFaces: 1 },
  { file: "apollo11-crew.jpg", minFaces: 3 },
]) {
  test(`${file}: detected faces are blacked out with margin and can no longer be detected`, async () => {
    const image = await loadJpeg(file);
    const original: RawImage = { ...image, data: new Uint8ClampedArray(image.data) };

    const detection = await runInference(image);
    assert.ok(detection.sensitiveRegions.length >= minFaces, `expected >= ${minFaces} faces, got ${detection.sensitiveRegions.length}`);

    const result = redact(image, detection.sensitiveRegions);
    const saved = await saveJpeg(file.replace(/\.jpg$/, ".redacted.jpg"), result.image);

    console.log(
      `\n${file}  ${image.width}x${image.height}\n` +
        `${describe("detected", detection.sensitiveRegions)}\n` +
        `${describe("masked  ", result.masked)}\n` +
        `  redacted -> ${path.relative(root, saved)}`
    );

    assert.equal(result.changed, true);
    assert.equal(result.masked.length, detection.sensitiveRegions.length);
    assert.notEqual(result.image.data, image.data);

    // Each painted box contains its detection with at least a 10% margin on every side not clipped by the image edge.
    detection.sensitiveRegions.forEach((d, i) => {
      const m = result.masked[i]!.bbox;
      const mx = d.bbox.width * 0.1;
      const my = d.bbox.height * 0.1;
      assert.ok(m.x === 0 || m.x <= d.bbox.x - mx, `left margin [${i}]`);
      assert.ok(m.y === 0 || m.y <= d.bbox.y - my, `top margin [${i}]`);
      assert.ok(m.x + m.width === image.width || m.x + m.width >= d.bbox.x + d.bbox.width + mx, `right margin [${i}]`);
      assert.ok(m.y + m.height === image.height || m.y + m.height >= d.bbox.y + d.bbox.height + my, `bottom margin [${i}]`);
    });

    assertMaskExact(original, result.image, result.masked);

    const after = await runInference(result.image);
    console.log(`  detector on redacted image: faces=${after.sensitiveRegions.length}`);
    assert.equal(after.sensitiveRegions.length, 0, "no face should survive redaction");
  });
}

test("coffee.jpg: nothing detected, image passes through unchanged", async () => {
  const image = await loadJpeg("coffee.jpg");
  const detection = await runInference(image);
  assert.equal(detection.sensitiveRegions.length, 0);
  const result = redact(image, detection.sensitiveRegions);
  assert.equal(result.image, image);
  assert.equal(result.changed, false);
  console.log(`\ncoffee.jpg: faces=0, redact() returned the input object unchanged`);
});

// ---------------------------------------------------------------------------
// pipeline: sanitize()
// ---------------------------------------------------------------------------

test("sanitize() masks pixels, reports CSS-pixel regions, and wipes the source buffer", async () => {
  const image = await loadJpeg("astronaut.jpg");
  const original: RawImage = { ...image, data: new Uint8ClampedArray(image.data) };
  const perception = await runInference(image);
  const dpr = 2;

  const result = await sanitize({ screenshot: image, elements: [], perception, devicePixelRatio: dpr });

  assert.ok(result.screenshot && result.screenshot !== image);
  assert.equal(result.redactions.length, perception.sensitiveRegions.length);
  assert.ok(image.data.every((v) => v === 0), "input screenshot buffer wiped");

  // Wire regions are the padded boxes in CSS px (screenshot px / dpr).
  const paddedPx = redact(original, perception.sensitiveRegions).masked;
  assert.deepEqual(result.redactions, toCssPixels(paddedPx, dpr));
  assert.equal(result.redactions[0]!.category, "face");
  assert.equal(result.redactions[0]!.method, "ml");
  assert.ok(Math.abs(result.redactions[0]!.bbox.width * dpr - paddedPx[0]!.bbox.width) < 0.11);

  assertMaskExact(original, result.screenshot, paddedPx);
  const saved = await saveJpeg("astronaut.sanitized.jpg", result.screenshot);
  console.log(`\nsanitize(): ${result.redactions.length} region(s) reported in CSS px at dpr=${dpr}: ${JSON.stringify(result.redactions[0]!.bbox)}\n  -> ${path.relative(root, saved)}`);
});

test("sanitize() without a screenshot reports nothing and returns null pixels", async () => {
  const result = await sanitize({
    screenshot: null,
    elements: [],
    perception: { modelId: "placeholder", latencyMs: 0, sensitiveRegions: [], uiElements: [] },
    devicePixelRatio: 1,
  });
  assert.equal(result.screenshot, null);
  assert.deepEqual(result.redactions, []);
});
