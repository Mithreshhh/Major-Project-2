/**
 * Smoke tests of one agent step, run against the BUILT Chrome bundle with a stubbed chrome.*
 * API, a stubbed fetch, and minimal OffscreenCanvas / createImageBitmap / ImageData shims.
 *
 * The real ONNX Runtime WASM and the real UltraFace model are served from dist/chrome through
 * the fetch stub, so with sendScreenshot=true this exercises the shipped pipeline end to end:
 * capture -> decode -> detect faces -> black them out -> encode -> POST /process. The test then
 * inspects the exact pixels that reached the server.
 *
 *   npm run build && npm test        (from extension/)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import jpeg from "jpeg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist/chrome");
const bundlePath = path.join(distDir, "background.js");
const configSource = readFileSync(path.join(root, "src/shared/config.ts"), "utf8");
const screenshotsEnabled = /sendScreenshot:\s*true\b/.test(configSource);

// The "screenshot" the stubbed captureVisibleTab returns: a portrait with one clear face.
const fixturePath = path.resolve(root, "../perception/test/fixtures/astronaut.jpg");
const fixtureJpeg = readFileSync(fixturePath);
const fixture = decodeJpeg(fixtureJpeg);
/** Face centre in that fixture, as measured by perception/test/face-detector.test.ts. */
const FACE_CENTRE = { x: 224, y: 113 };

const snapshot = {
  page: { url: "http://127.0.0.1:5500/", title: "Agent test page", capturedAt: new Date().toISOString() },
  viewport: { width: fixture.width, height: fixture.height, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  elements: [
    { id: "el_0", role: "textbox", label: "Email", bbox: { x: 100, y: 200, width: 300, height: 32 }, isVisible: true, isInteractive: true },
    { id: "el_1", role: "button", label: "Submit", bbox: { x: 100, y: 260, width: 120, height: 40 }, isVisible: true, isInteractive: true },
  ],
};

function decodeJpeg(bytes) {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

function inside(x, y, boxes) {
  return boxes.some((b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
}

// ---------------------------------------------------------------------------
// Stubs (installed once; the bundle registers its listeners against them)
// ---------------------------------------------------------------------------

const calls = { capture: 0, badges: [], sent: [], fetches: [], logs: [], assets: [], encodedAs: null };
let onClicked = null;

function reset() {
  calls.capture = 0;
  calls.badges.length = 0;
  calls.sent.length = 0;
  calls.fetches.length = 0;
  calls.logs.length = 0;
  calls.encodedAs = null;
  // calls.assets is cumulative on purpose: the model loads once and is cached across steps.
}

globalThis.self = globalThis;
globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  action: {
    onClicked: { addListener(fn) { onClicked = fn; } },
    setBadgeText: async ({ text }) => { calls.badges.push(text); },
    setBadgeBackgroundColor: async () => {},
  },
  tabs: {
    onRemoved: { addListener() {} },
    captureVisibleTab: async () => {
      calls.capture += 1;
      return `data:image/jpeg;base64,${fixtureJpeg.toString("base64")}`;
    },
    sendMessage: async (_tabId, message) => {
      calls.sent.push(message);
      if (message.type === "CAPTURE_DOM") return { type: "DOM_SNAPSHOT", snapshot };
      if (message.type === "EXECUTE_ACTION") return { type: "EXECUTION_RESULT", result: { ok: true } };
      return { type: "ERROR", message: `unexpected ${message.type}` };
    },
  },
  scripting: {
    executeScript: async () => { throw new Error("content script injection not expected here"); },
  },
  storage: { local: { get: async () => ({}) } },
};

// Just enough canvas for src/background/image.ts. convertToBlob emits raw RGBA instead of a
// real JPEG so the test can compare pixels exactly; the requested mime type is recorded.
globalThis.createImageBitmap = async (blob) => {
  const img = decodeJpeg(Buffer.from(await blob.arrayBuffer()));
  return { width: img.width, height: img.height, pixels: img.data, close() {} };
};
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
globalThis.OffscreenCanvas = class OffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }
  getContext(kind) {
    if (kind !== "2d") return null;
    const canvas = this;
    return {
      drawImage(bitmap) { canvas.pixels.set(bitmap.pixels); },
      getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(canvas.pixels), width, height }; },
      putImageData(imageData) { canvas.pixels.set(imageData.data); },
    };
  }
  async convertToBlob({ type } = {}) {
    calls.encodedAs = type ?? null;
    return new Blob([this.pixels]);
  }
};

const realFetch = globalThis.fetch;
const EXT_PREFIX = "chrome-extension://test/";
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("data:")) return realFetch(url);
  if (url.startsWith(EXT_PREFIX)) {
    // Extension-internal assets (ORT wasm, ONNX model) come straight from the built bundle dir.
    const file = path.join(distDir, url.slice(EXT_PREFIX.length));
    calls.assets.push(path.relative(distDir, file).replaceAll("\\", "/"));
    const type = file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(readFileSync(file), { status: 200, headers: { "content-type": type } });
  }
  calls.fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ action: "click", target: "el_1", reasoning: "stub" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

for (const level of ["info", "warn", "error", "debug"]) {
  console[level] = (...args) => calls.logs.push([level, ...args.map(String)]);
}

assert.ok(existsSync(bundlePath), `bundle missing at ${bundlePath}; run \`npm run build\` first`);
vm.runInThisContext(readFileSync(bundlePath, "utf8"), { filename: bundlePath });
assert.equal(typeof onClicked, "function", "bundle did not register an action.onClicked listener");

beforeEach(reset);

const errors = () => JSON.stringify(calls.logs.filter(([level]) => level === "error"));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  "one step with sendScreenshot=true sends a face-redacted screenshot, never the raw pixels",
  { skip: !screenshotsEnabled && "sendScreenshot is false in config.ts; this test covers the on state" },
  async () => {
    await onClicked({ id: 7, windowId: 1, url: "http://127.0.0.1:5500/" });

    assert.equal(calls.badges.at(-1), "OK", `badges: ${calls.badges.join(" -> ")}; errors: ${errors()}`);
    assert.equal(calls.capture, 1, "captureVisibleTab called exactly once");
    assert.ok(calls.assets.includes("models/version-RFB-640.onnx"), `real model loaded from dist: ${calls.assets}`);
    assert.ok(calls.assets.some((a) => a.startsWith("ort/") && a.endsWith(".wasm")), `real ORT wasm loaded from dist: ${calls.assets}`);
    assert.equal(calls.fetches.length, 1, `expected only the /process POST, got ${JSON.stringify(calls.fetches.map((f) => f.url))}`);

    const body = calls.fetches[0].body;
    assert.equal(body.perception.modelId, "ultraface-rfb-640");
    assert.ok(body.perception.latencyMs >= 0);

    const faces = body.redactions.filter((r) => r.category === "face" && r.method === "ml");
    assert.ok(faces.length >= 1, `expected a face redaction, got ${JSON.stringify(body.redactions)}`);
    const boxes = body.redactions.map((r) => r.bbox);
    assert.ok(inside(FACE_CENTRE.x, FACE_CENTRE.y, boxes), `face centre not covered: ${JSON.stringify(boxes)}`);

    const shot = body.screenshot;
    assert.ok(shot, "screenshot present in payload");
    assert.equal(shot.mimeType, "image/jpeg");
    assert.equal(calls.encodedAs, "image/jpeg", "encoder asked for the configured mime type");
    assert.equal(shot.width, fixture.width);
    assert.equal(shot.height, fixture.height);

    // Our canvas shim emits raw RGBA, so the payload decodes to pixels directly.
    const sent = new Uint8ClampedArray(Buffer.from(shot.dataBase64, "base64"));
    assert.equal(sent.length, fixture.data.length, "payload is a full RGBA frame");
    assert.notDeepEqual(sent, fixture.data, "payload is not the raw capture");

    const origin = (FACE_CENTRE.y * fixture.width + FACE_CENTRE.x) * 4;
    assert.ok(fixture.data[origin] + fixture.data[origin + 1] + fixture.data[origin + 2] > 100, "fixture face is not black to begin with");

    let insideN = 0, notBlackInside = 0, changedOutside = 0;
    for (let y = 0; y < fixture.height; y++) {
      for (let x = 0; x < fixture.width; x++) {
        const i = (y * fixture.width + x) * 4;
        if (inside(x, y, boxes)) {
          insideN++;
          if (sent[i] !== 0 || sent[i + 1] !== 0 || sent[i + 2] !== 0 || sent[i + 3] !== 255) notBlackInside++;
        } else if (sent[i] !== fixture.data[i] || sent[i + 1] !== fixture.data[i + 1] || sent[i + 2] !== fixture.data[i + 2] || sent[i + 3] !== fixture.data[i + 3]) {
          changedOutside++;
        }
      }
    }
    assert.ok(insideN > 1000, `mask covers a real area (${insideN} px)`);
    assert.equal(notBlackInside, 0, "every pixel inside the reported regions is opaque black");
    assert.equal(changedOutside, 0, "every pixel outside the reported regions is untouched");

    assert.deepEqual(calls.sent.map((m) => m.type), ["CAPTURE_DOM", "EXECUTE_ACTION"]);
    assert.equal(calls.sent[1].command.target, "el_1");
    assert.ok(
      calls.logs.some((entry) => entry.slice(1).join(" ").includes("blacked out")),
      `worker logged the redaction; logs: ${JSON.stringify(calls.logs)}`
    );
  }
);

test(
  "one step with sendScreenshot=false captures, decodes, encodes and sends no pixels",
  { skip: screenshotsEnabled && "sendScreenshot is true in config.ts; this test covers the off state" },
  async () => {
    await onClicked({ id: 7, windowId: 1, url: "http://127.0.0.1:5500/" });

    assert.equal(calls.capture, 0, "captureVisibleTab must not be called");
    assert.equal(calls.fetches.length, 1, `expected only the /process POST, got ${JSON.stringify(calls.fetches.map((f) => f.url))}`);
    assert.equal(calls.assets.length, 0, "no model or wasm loaded");

    const [request] = calls.fetches;
    assert.ok(request.url.endsWith("/process"), request.url);
    assert.equal(request.body.screenshot, null);
    assert.equal(request.body.perception.modelId, "placeholder");
    assert.equal(request.body.redactions.length, 0);
    assert.equal(calls.badges.at(-1), "OK", `badges: ${calls.badges.join(" -> ")}`);
  }
);

test("clicking on a non-http tab does nothing but flag the badge", async () => {
  await onClicked({ id: 8, windowId: 1, url: "chrome://newtab/" });

  assert.equal(calls.capture, 0);
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.deepEqual(calls.badges, ["!"]);
});

test("a second step on the same tab carries the first command in history", async () => {
  await onClicked({ id: 9, windowId: 1, url: "http://127.0.0.1:5500/" });
  await onClicked({ id: 9, windowId: 1, url: "http://127.0.0.1:5500/" });

  assert.equal(calls.fetches.length, 2, errors());
  assert.equal(calls.fetches[0].body.stepIndex, 0);
  assert.equal(calls.fetches[1].body.stepIndex, 1);
  assert.deepEqual(calls.fetches[1].body.history, [{ action: "click", target: "el_1", reasoning: "stub" }]);
  assert.equal(calls.capture, screenshotsEnabled ? 2 : 0);
});
