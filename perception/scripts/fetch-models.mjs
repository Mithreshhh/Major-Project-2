/**
 * Fetch (if missing) and verify the downloaded ONNX models in perception/models/: UltraFace
 * (face detection) and PaddleOCR PP-OCRv3 English (on-device OCR, Apache-2.0, ONNX conversions
 * by RapidOCR). The UI detector is trained here (ui-model/), so it is not fetched.
 * The files are committed; this script documents their origin and guards against tampering.
 *
 *   node scripts/fetch-models.mjs            verify, download anything missing
 *   node scripts/fetch-models.mjs --force    re-download everything
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.resolve(here, "../models");
const force = process.argv.includes("--force");

const ULTRAFACE = "https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx";
const RAPIDOCR = "https://huggingface.co/SWHL/RapidOCR/resolve/main";

export const MODELS = [
  {
    file: "version-RFB-320.onnx",
    url: `${ULTRAFACE}/version-RFB-320.onnx`,
    sha256: "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017",
    input: "1x3x240x320",
  },
  {
    file: "version-RFB-640.onnx",
    url: `${ULTRAFACE}/version-RFB-640.onnx`,
    sha256: "8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430",
    input: "1x3x480x640",
  },
  {
    file: "ocr-det-en-v3.onnx",
    url: `${RAPIDOCR}/PP-OCRv4/en_PP-OCRv3_det_infer.onnx`,
    sha256: "f139598bc2af4e4b6fe98dec11574e30edfdd91fc94ac1425c18ace3bd5a866b",
    input: "1x3xHxW (sides multiples of 32)",
  },
  {
    file: "ocr-rec-en-v3.onnx",
    url: `${RAPIDOCR}/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx`,
    sha256: "ef7abd8bd3629ae57ea2c28b425c1bd258a871b93fd2fe7c433946ade9b5d9ea",
    input: "1x3x48xW",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

await mkdir(modelsDir, { recursive: true });
let failed = false;

for (const model of MODELS) {
  const target = path.join(modelsDir, model.file);
  if (force || !(await exists(target))) {
    const url = model.url;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    console.log(`downloaded ${model.file} <- ${url}`);
  }
  const bytes = await readFile(target);
  const digest = sha256(bytes);
  const ok = digest === model.sha256;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${model.file}  ${bytes.byteLength} bytes  input ${model.input}  sha256 ${digest.slice(0, 16)}…`);
}

if (failed) {
  console.error("checksum mismatch: delete the file and re-run, or run with --force");
  process.exit(1);
}
