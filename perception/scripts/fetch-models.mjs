/**
 * Fetch (if missing) and verify the UltraFace ONNX models in perception/models/.
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

const UPSTREAM = "https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx";

export const MODELS = [
  {
    file: "version-RFB-320.onnx",
    sha256: "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017",
    input: "1x3x240x320",
  },
  {
    file: "version-RFB-640.onnx",
    sha256: "8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430",
    input: "1x3x480x640",
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
    const url = `${UPSTREAM}/${model.file}`;
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
