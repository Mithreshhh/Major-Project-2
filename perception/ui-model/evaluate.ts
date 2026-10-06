/**
 * Scores models/ui-detect.onnx with the same TypeScript code the extension runs (letterbox,
 * decode, NMS, DOM matching) on
 *   - dataset/images/demo: the real demo page, 21 screenshots, never trained on
 *   - dataset/images/val:  200 synthetic pages, never trained on
 * at several confidence thresholds. Writes RESULTS.md and results.json next to this file.
 *
 *   npx tsx ui-model/evaluate.ts        (from perception/)
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { UIElement } from "@odpa/shared";
import jpeg from "jpeg-js";

import { configureRuntime } from "../src/inference";
import type { RawImage } from "../src/types";
import { compareWithDom, detectUiElements, loadUiDetector, type UiDetection } from "../src/ui-detector";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.resolve(here, "..", "models", "ui-detect.onnx");
const THRESHOLDS = [0.25, 0.35, 0.5, 0.6, 0.7];
const ROLES: UIElement["role"][] = ["button", "textbox", "link"];
const CLASS_NAMES = ["button", "input", "link"];

interface Frame {
  file: string;
  truth: UIElement[];
  detections: UiDetection[];
  width: number;
  height: number;
  ms: number;
}

async function runSplit(split: string, limit = Infinity): Promise<Frame[]> {
  const dir = path.join(here, "dataset", "images", split);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg") && !f.includes(".preview")).sort().slice(0, limit);
  const frames: Frame[] = [];
  for (const file of files) {
    const decoded = jpeg.decode(await readFile(path.join(dir, file)), { useTArray: true, formatAsRGBA: true });
    const image: RawImage = { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) };
    const labels = await readFile(path.join(here, "dataset", "labels", split, file.replace(/\.jpg$/, ".txt")), "utf8");
    const truth = labels.trim().split("\n").filter(Boolean).map((line, i): UIElement => {
      const [c, cx, cy, w, h] = line.split(" ").map(Number) as [number, number, number, number, number];
      return {
        id: `gt_${i}`, role: ROLES[c]!, label: "", isVisible: true, isInteractive: true,
        bbox: { x: (cx - w / 2) * image.width, y: (cy - h / 2) * image.height, width: w * image.width, height: h * image.height },
      };
    });
    const out = await detectUiElements(image);
    frames.push({ file, truth, detections: out.detections, width: image.width, height: image.height, ms: out.latencyMs });
  }
  return frames;
}

function score(frames: Frame[], threshold: number) {
  const perClass = ROLES.map(() => ({ truth: 0, found: 0, detections: 0, correct: 0 }));
  for (const f of frames) {
    const dets = f.detections.filter((d) => d.confidence >= threshold);
    for (const [c, role] of ROLES.entries()) {
      const cmp = compareWithDom(dets.filter((d) => d.role === (["button", "textbox", "link"] as const)[c]), f.truth.filter((t) => t.role === role), 1, f);
      perClass[c]!.truth += cmp.domCount;
      perClass[c]!.found += cmp.found;
      perClass[c]!.detections += cmp.visual.length;
      perClass[c]!.correct += cmp.correct;
    }
  }
  const sum = perClass.reduce((a, b) => ({ truth: a.truth + b.truth, found: a.found + b.found, detections: a.detections + b.detections, correct: a.correct + b.correct }));
  const pr = (x: typeof sum) => ({
    recall: x.truth ? x.found / x.truth : 1,
    precision: x.detections ? x.correct / x.detections : 1,
    ...x,
  });
  return { threshold, all: pr(sum), perClass: perClass.map(pr) };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function main() {
  configureRuntime({ numThreads: 1 });
  // Collect everything at the lowest threshold, then filter per threshold.
  await loadUiDetector({ modelBytes: new Uint8Array(await readFile(modelPath)), scoreThreshold: Math.min(...THRESHOLDS) });
  const splits = { demo: await runSplit("demo"), val: await runSplit("val") };

  const results = Object.fromEntries(Object.entries(splits).map(([name, frames]) => [name, {
    frames: frames.length,
    medianMs: median(frames.map((f) => f.ms)),
    scores: THRESHOLDS.map((t) => score(frames, t)),
  }]));
  await writeFile(path.join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");

  const table = (name: string, title: string) => {
    const r = results[name]!;
    const rows = r.scores.map((s) => `| ${s.threshold} | ${pct(s.all.recall)} (${s.all.found}/${s.all.truth}) | ${pct(s.all.precision)} (${s.all.correct}/${s.all.detections}) | ` +
      s.perClass.map((c) => `${pct(c.recall)} / ${pct(c.precision)}`).join(" | ") + " |");
    return [`### ${title}`, "", `${r.frames} screenshots, median ${r.medianMs} ms per screenshot (single-threaded WASM, Node).`, "",
      "| Confidence ≥ | Recall | Precision | " + CLASS_NAMES.map((c) => `${c} R / P`).join(" | ") + " |",
      "| --- | --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
  };
  const md = [
    "# UI detector results",
    "",
    "Generated by `npx tsx ui-model/evaluate.ts` with the same code the extension runs. A detection is",
    "correct when it overlaps a real element of the same class with IoU ≥ 0.5. Recall = real elements",
    "found; precision = detections that are real elements. The extension uses confidence ≥ 0.5.",
    "",
    table("demo", "Test site: contact, application, store, pricing, features and login pages (held out: never used in training)"),
    table("val", "Synthetic validation pages (held out)"),
  ].join("\n");
  await writeFile(path.join(here, "RESULTS.md"), md);
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });
