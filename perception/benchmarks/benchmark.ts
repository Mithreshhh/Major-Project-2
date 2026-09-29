/**
 * Compression study: size, load time, speed, memory and accuracy for every UltraFace variant,
 * each measured in its own process with the same runtime and code the extension ships.
 *
 *   npm run benchmark            (from perception/; build variants first with benchmarks/quantize.py)
 *
 * Writes benchmarks/RESULTS.md and benchmarks/results.json.
 *
 * Accuracy:
 *   recall          faces found / faces present, on the portrait (1) and the Apollo crew (3)
 *   false positives detections on the coffee cup (true negative, should be 0)
 *   IoU vs FP32     how closely boxes match the same-resolution FP32 model's boxes (1.0 = identical)
 *   cat             detections on the cat photo, a known confuser (reported, not scored)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SensitiveRegion } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const RUNS = Number(process.env.BENCH_RUNS ?? 30);
const TRUTH: Record<string, number> = { "astronaut.jpg": 1, "apollo11-crew.jpg": 3 };

interface Result {
  model: string;
  sizeBytes: number;
  error?: string;
  loadMs?: number;
  latencyMs?: { mean: number; p50: number; p95: number; runs: number };
  memoryMb?: { loadDelta: number; peakDelta: number; peakRss: number };
  detections?: Record<string, SensitiveRegion[]>;
}

function variants(): string[] {
  const out: string[] = [];
  for (const base of ["version-RFB-320", "version-RFB-640"]) {
    out.push(`models/${base}.onnx`);
    for (const kind of ["fp32-clean", "fp16", "int8-dynamic", "int8-static"]) {
      const p = `models/compressed/${base}.${kind}.onnx`;
      if (existsSync(path.join(root, p))) out.push(p);
    }
  }
  return out;
}

function measure(model: string): Result {
  const stdout = execFileSync(process.execPath, ["--import", "tsx", path.join(here, "run-variant.ts"), model, String(RUNS)], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error(`no JSON from run-variant for ${model}:\n${stdout}`);
  return JSON.parse(line) as Result;
}

function iou(a: SensitiveRegion["bbox"], b: SensitiveRegion["bbox"]): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter === 0 ? 0 : inter / (a.width * a.height + b.width * b.height - inter);
}

/** Mean best-match IoU of reference boxes against candidate boxes, over the scored images. */
function meanIou(ref: Record<string, SensitiveRegion[]>, cand: Record<string, SensitiveRegion[]>): number | null {
  const scores: number[] = [];
  for (const f of Object.keys(TRUTH)) {
    for (const r of ref[f] ?? []) scores.push(Math.max(0, ...(cand[f] ?? []).map((c) => iou(r.bbox, c.bbox))));
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function recall(d: Record<string, SensitiveRegion[]>): { found: number; total: number } {
  let found = 0;
  let total = 0;
  for (const [f, n] of Object.entries(TRUTH)) {
    total += n;
    found += Math.min(n, (d[f] ?? []).length);
  }
  return { found, total };
}

const label = (model: string) => {
  const m = /version-RFB-(\d+)(?:\.(.+))?\.onnx$/.exec(model);
  if (!m) return model;
  const precision =
    {
      undefined: "FP32 original export",
      "fp32-clean": "FP32 cleaned graph",
      fp16: "FP16",
      "int8-dynamic": "INT8 dynamic",
      "int8-static": "INT8 static",
    }[String(m[2])] ?? m[2];
  return `RFB-${m[1]} ${precision}`;
};

const results: Result[] = [];
for (const v of variants()) {
  process.stderr.write(`measuring ${v} ...\n`);
  results.push(measure(v));
}

const reference = (res: string) => results.find((r) => r.model === `models/version-RFB-${res}.onnx`);
const rows = results.map((r) => {
  const res = /RFB-(\d+)/.exec(r.model)?.[1] ?? "";
  const ref = reference(res);
  const base = ref?.sizeBytes ?? r.sizeBytes;
  if (r.error || !r.detections || !r.latencyMs || !r.memoryMb) {
    return { label: label(r.model), model: r.model, sizeKb: Math.round(r.sizeBytes / 1024), error: r.error ?? "failed" };
  }
  const rc = recall(r.detections);
  return {
    label: label(r.model),
    model: r.model,
    sizeKb: Math.round(r.sizeBytes / 1024),
    sizeVsFp32: Math.round((r.sizeBytes / base) * 100),
    loadMs: r.loadMs,
    latency: r.latencyMs,
    speedupVsFp32: ref?.latencyMs ? Math.round((ref.latencyMs.p50 / r.latencyMs.p50) * 100) / 100 : null,
    memory: r.memoryMb,
    recall: `${rc.found}/${rc.total}`,
    falsePositives: (r.detections["coffee.jpg"] ?? []).length,
    catDetections: (r.detections["chelsea-cat.jpg"] ?? []).length,
    iouVsFp32: ref?.detections ? meanIou(ref.detections, r.detections) : null,
    minConfidence: Math.min(...Object.keys(TRUTH).flatMap((f) => (r.detections![f] ?? []).map((d) => d.confidence))),
  };
});

writeFileSync(path.join(here, "results.json"), JSON.stringify({ runs: RUNS, node: process.version, date: new Date().toISOString(), rows, raw: results }, null, 2));

const md: string[] = [];
md.push("# Face detector compression study", "");
md.push(
  `Measured ${new Date().toISOString().slice(0, 10)} on ${process.platform}/${process.arch}, Node ${process.version}, onnxruntime-web on single-threaded WASM (the same runtime and code the extension ships). ` +
    `Latency is the median / mean / 95th percentile of ${RUNS} runs on a 960x754 photo, including resize and NMS; speed-up compares medians, which ignore one-off stalls. ` +
    "Memory is the resident-set growth of a fresh process. Each variant runs in its own process.",
  ""
);
md.push("| Variant | Size | vs FP32 | Load | Latency median / mean / p95 | Speed-up (median) | Memory (peak growth) | Recall | False positives | Box IoU vs FP32 |");
md.push("| --- | ---: | ---: | ---: | --- | ---: | ---: | :---: | :---: | ---: |");
for (const r of rows) {
  if ("error" in r) {
    md.push(`| ${r.label} | ${r.sizeKb} KB | | | does not run: ${String(r.error).slice(0, 90)} | | | | | |`);
    continue;
  }
  md.push(
    `| ${r.label} | ${r.sizeKb} KB | ${r.sizeVsFp32}% | ${r.loadMs} ms | ${r.latency.p50} / ${r.latency.mean} / ${r.latency.p95} ms | ${r.speedupVsFp32}x | ${r.memory.peakDelta} MB | ${r.recall} | ${r.falsePositives} | ${r.iouVsFp32 === null ? "n/a" : r.iouVsFp32.toFixed(3)} |`
  );
}
md.push("");
md.push("Recall counts faces found on the portrait (1 face) and the Apollo 11 crew photo (3 faces). False positives are detections on a coffee-cup photo with no face. Box IoU compares each variant's boxes with the FP32 model of the same input size (1.000 = identical boxes).");
md.push("");
md.push("Cat photo (a known confuser for human-face detectors, not scored): " + rows.filter((r) => !("error" in r)).map((r) => `${r.label} ${(r as { catDetections: number }).catDetections}`).join(", ") + ".");
md.push("");
md.push("Reproduce: `benchmarks/.venv/Scripts/python benchmarks/quantize.py` then `npm run benchmark` (from `perception/`).");
writeFileSync(path.join(here, "RESULTS.md"), md.join("\n") + "\n");

console.log(md.join("\n"));
