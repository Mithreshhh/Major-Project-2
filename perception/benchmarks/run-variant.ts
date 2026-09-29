/**
 * Measure ONE model variant in a fresh process (so memory numbers are not polluted by other
 * variants) using the exact same code the extension ships: onnxruntime-web on single-threaded
 * WASM, perception/src/preprocess.ts and postprocess.ts. Prints one JSON object on stdout.
 *
 *   node --import tsx benchmarks/run-variant.ts <model.onnx> [runs]
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";

import { loadModel, runInference } from "../src/inference";
import type { RawImage, SensitiveRegion } from "../src/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.resolve(root, process.argv[2] ?? "models/version-RFB-640.onnx");
const runs = Number(process.argv[3] ?? 20);
const FIXTURES = ["astronaut.jpg", "apollo11-crew.jpg", "coffee.jpg", "chelsea-cat.jpg"];
const TIMING_IMAGE = "apollo11-crew.jpg";

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const rss = () => process.memoryUsage().rss;

async function loadJpeg(file: string): Promise<RawImage> {
  const bytes = await readFile(path.join(root, "test/fixtures", file));
  const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

async function main() {
  const images = Object.fromEntries(await Promise.all(FIXTURES.map(async (f) => [f, await loadJpeg(f)] as const)));
  const bytes = new Uint8Array(await readFile(modelPath));
  const sizeBytes = (await stat(modelPath)).size;

  const rssBefore = rss();
  const t0 = performance.now();
  let loadError: string | null = null;
  try {
    await loadModel({ modelBytes: bytes, modelId: path.basename(modelPath), executionProviders: ["wasm"], numThreads: 1 });
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  const loadMs = performance.now() - t0;
  const rssAfterLoad = rss();

  if (loadError) {
    console.log(JSON.stringify({ model: path.relative(root, modelPath).replaceAll("\\", "/"), sizeBytes, error: loadError.split("\n")[0] }));
    return;
  }

  // Accuracy input: detections on every fixture.
  const detections: Record<string, SensitiveRegion[]> = {};
  for (const f of FIXTURES) detections[f] = (await runInference(images[f]!)).sensitiveRegions;

  // Speed: warm-up then timed runs on the 960x754 crew photo (includes resize + NMS).
  const timingImage = images[TIMING_IMAGE]!;
  for (let i = 0; i < 3; i++) await runInference(timingImage);
  const times: number[] = [];
  let peak = rss();
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await runInference(timingImage);
    times.push(performance.now() - s);
    peak = Math.max(peak, rss());
  }
  times.sort((a, b) => a - b);

  console.log(
    JSON.stringify({
      model: path.relative(root, modelPath).replaceAll("\\", "/"),
      sizeBytes,
      loadMs: Math.round(loadMs),
      latencyMs: {
        mean: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10,
        p50: Math.round(percentile(times, 50) * 10) / 10,
        p95: Math.round(percentile(times, 95) * 10) / 10,
        runs,
      },
      memoryMb: { loadDelta: mb(rssAfterLoad - rssBefore), peakDelta: mb(peak - rssBefore), peakRss: mb(peak) },
      detections,
    })
  );
}

main().catch((err) => {
  console.log(JSON.stringify({ model: process.argv[2], error: String(err) }));
  process.exitCode = 1;
});
