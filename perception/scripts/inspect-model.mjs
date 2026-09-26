/**
 * Print an ONNX model's inputs/outputs as seen by ONNX Runtime Web, and run one zero-filled
 * pass to show the output shapes. Handy when swapping detectors.
 *
 *   node scripts/inspect-model.mjs [models/version-RFB-320.onnx]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-web";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.resolve(root, process.argv[2] ?? "models/version-RFB-320.onnx");

ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

const bytes = new Uint8Array(await readFile(modelPath));
const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], logSeverityLevel: 3 });

console.log("model:", path.relative(root, modelPath), `(${bytes.byteLength} bytes)`);
console.log("inputs:", session.inputMetadata.map((m) => `${m.name} ${m.type} [${m.shape}]`));
console.log("outputs:", session.outputMetadata.map((m) => `${m.name} ${m.type} [${m.shape}]`));

const input = session.inputMetadata[0];
const dims = input.shape.map((d) => (typeof d === "number" ? d : 1));
const feeds = { [input.name]: new ort.Tensor("float32", new Float32Array(dims.reduce((a, b) => a * b, 1)), dims) };
const t0 = performance.now();
const outputs = await session.run(feeds);
const ms = (performance.now() - t0).toFixed(1);
for (const [name, tensor] of Object.entries(outputs)) {
  console.log(`output ${name}: dims [${tensor.dims}] first values`, Array.from(tensor.data.slice(0, 6)).map((v) => +v.toFixed(4)));
}
console.log(`zero-input pass: ${ms} ms (wasm, 1 thread)`);
await session.release();
