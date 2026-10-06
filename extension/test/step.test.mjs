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
    // Password field -> DOM rule should black it out.
    { id: "el_2", role: "textbox", label: "Account password", attributes: { type: "password" }, bbox: { x: 300, y: 440, width: 180, height: 30 }, isVisible: true, isInteractive: true },
    // A link whose label is an email -> label must arrive as [REDACTED].
    { id: "el_3", role: "link", label: "jane.doe@example.com", bbox: { x: 20, y: 20, width: 150, height: 18 }, isVisible: true, isInteractive: true },
  ],
  // PII found by the content script in page text (only the box crosses over).
  textRegions: [{ bbox: { x: 40, y: 470, width: 150, height: 18 }, category: "phone", confidence: 0.99, method: "heuristic" }],
};

/** Commands the stubbed /process returns, in order; when empty it answers "click el_1". */
const serverScript = [];

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

/** Visible text the content script would return for a question (includeText). */
const PAGE_TEXT = "Sign in to Acme\nEmail jane.doe@example.com\nPhone +91 98765 43210\nForgot password?";

const calls = { capture: 0, badges: [], sent: [], fetches: [], logs: [], assets: [], encodedAs: null, broadcasts: [] };
let onClicked = null;
let onMessage = null;
const sessionStore = {};
/** chrome.storage.local: holds the user's saved details ("My info") in the tests that set them. */
const localStore = {};

function reset() {
  calls.capture = 0;
  calls.badges.length = 0;
  calls.sent.length = 0;
  calls.fetches.length = 0;
  calls.logs.length = 0;
  calls.broadcasts.length = 0;
  calls.encodedAs = null;
  serverScript.length = 0;
  // calls.assets is cumulative on purpose: the model loads once and is cached across steps.
}

globalThis.self = globalThis;
globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessage = fn; } },
    sendMessage: async (msg) => { calls.broadcasts.push(msg); },
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
      if (message.type === "CAPTURE_DOM") {
        return { type: "DOM_SNAPSHOT", snapshot: message.includeText ? { ...snapshot, pageText: PAGE_TEXT } : snapshot };
      }
      if (message.type === "EXECUTE_ACTION") return { type: "EXECUTION_RESULT", result: { ok: true } };
      return { type: "ERROR", message: `unexpected ${message.type}` };
    },
  },
  scripting: {
    executeScript: async () => { throw new Error("content script injection not expected here"); },
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in localStore).map((k) => [k, localStore[k]])),
      set: async (items) => { Object.assign(localStore, structuredClone(items)); },
    },
    session: {
      get: async (key) => ({ [key]: sessionStore[key] }),
      set: async (items) => { Object.assign(sessionStore, structuredClone(items)); },
    },
  },
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
  if (url.endsWith("/ask")) {
    return new Response(JSON.stringify({ answer: "stub answer" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const command = serverScript.shift() ?? { action: "click", target: "el_1", reasoning: "stub" };
  return new Response(JSON.stringify(command), {
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
    assert.ok(calls.assets.includes("models/version-RFB-640.fp32-clean.onnx"), `real model loaded from dist: ${calls.assets}`);
    assert.ok(calls.assets.some((a) => a.startsWith("ort/") && a.endsWith(".wasm")), `real ORT wasm loaded from dist: ${calls.assets}`);
    assert.equal(calls.fetches.length, 1, `expected only the /process POST, got ${JSON.stringify(calls.fetches.map((f) => f.url))}`);

    const body = calls.fetches[0].body;
    assert.equal(body.perception.modelId, "ultraface-rfb-640-clean");
    assert.ok(body.perception.latencyMs >= 0);

    // The UI detector ran on-device on the same frame and only boxes left (no text, no pixels).
    assert.ok(calls.assets.includes("models/ui-detect.onnx"), `UI model loaded from dist: ${calls.assets}`);
    assert.equal(body.perception.uiModelId, "ui-detect-yolo11n");
    assert.ok(body.perception.uiLatencyMs >= 0);
    assert.ok(Array.isArray(body.perception.visualElements));
    for (const v of body.perception.visualElements) {
      assert.deepEqual(Object.keys(v).filter((k) => !["role", "bbox", "confidence", "matchedId"].includes(k)), []);
      assert.ok(["button", "textbox", "link"].includes(v.role));
    }

    const faces = body.redactions.filter((r) => r.category === "face" && r.method === "ml");
    assert.ok(faces.length >= 1, `expected a face redaction, got ${JSON.stringify(body.redactions)}`);
    const boxes = body.redactions.map((r) => r.bbox);
    assert.ok(inside(FACE_CENTRE.x, FACE_CENTRE.y, boxes), `face centre not covered: ${JSON.stringify(boxes)}`);

    // Password field (dom) and PII text (heuristic) are blacked out alongside the face.
    const methods = new Set(body.redactions.map((r) => r.method));
    assert.deepEqual([...methods].sort(), ["dom", "heuristic", "ml"]);
    assert.ok(body.redactions.some((r) => r.method === "dom" && r.category === "credential"));
    assert.ok(inside(390, 455, boxes), "password field covered");
    assert.ok(inside(115, 479, boxes), "PII text covered");

    // PII in element labels never leaves as text.
    const link = body.elements.find((e) => e.id === "el_3");
    assert.equal(link.label, "[REDACTED]");
    assert.equal(link.redacted, true);
    assert.ok(!JSON.stringify(body).includes("jane.doe@example.com"), "raw email appears nowhere in the payload");

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

// ---------------------------------------------------------------------------
// Multi-step tasks (popup "Run task")
// ---------------------------------------------------------------------------

test("a task keeps stepping until the model says done", async () => {
  serverScript.push(
    { action: "type", target: "el_0", text: "john@example.com" },
    { action: "click", target: "el_1" },
    { action: "done", summary: "Form submitted." }
  );
  const state = await globalThis.odpa.runTask(20, 1, "Fill the email john@example.com and submit", { autoConfirm: true });

  assert.equal(state.status, "done", `${state.message}; errors: ${errors()}`);
  assert.equal(state.message, "Form submitted.");
  assert.deepEqual(state.steps.map((s) => s.summary), ['Type "john@example.com" into "Email"', 'Click "Submit"', "Done: Form submitted."]);
  assert.equal(calls.fetches.length, 3);
  assert.deepEqual(calls.fetches.map((f) => f.body.stepIndex), [0, 1, 2]);
  assert.ok(calls.fetches.every((f) => f.body.task === "Fill the email john@example.com and submit"));
  assert.equal(state.steps[1].confirmed, "auto", "clicking Submit is a risky action");
  assert.equal(calls.fetches[2].body.history.length, 2);
  assert.ok(state.steps.every((s) => s.redactions.faces >= (screenshotsEnabled ? 1 : 0)));
  assert.equal(calls.badges.at(-1), "OK");

  // Progress was broadcast to the popup and persisted for when it re-opens.
  const updates = calls.broadcasts.filter((m) => m.type === "TASK_UPDATE");
  assert.ok(updates.length >= 4, `expected start + 3 steps + finish, got ${updates.length}`);
  assert.equal(updates[0].state.status, "running");
  assert.equal(sessionStore["task:20"].status, "done");
});

test("a task stops when the model asks the user, and when it repeats itself", async () => {
  serverScript.push({ action: "ask_user", question: "Which email should I use?" });
  const asked = await globalThis.odpa.runTask(21, 1, "Sign me up");
  assert.equal(asked.status, "needs_user");
  assert.equal(asked.message, "Which email should I use?");
  assert.equal(asked.steps.length, 1);

  serverScript.push({ action: "click", target: "el_1" }, { action: "click", target: "el_1" }, { action: "click", target: "el_1" });
  const looped = await globalThis.odpa.runTask(22, 1, "Click submit", { autoConfirm: true });
  assert.equal(looped.status, "stopped");
  assert.match(looped.message, /same action twice/);
  assert.equal(looped.steps.length, 2);
  // The repeated click was refused, not executed: only one EXECUTE_ACTION reached the page.
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION" && m.command.target === "el_1").length, 1);
});

test("popup messages: RUN_TASK starts a task, GET_TASK_STATE reports it", async () => {
  serverScript.push({ action: "done", summary: "Nothing left to do." });
  const replies = [];
  const keepOpen = onMessage({ type: "RUN_TASK", tabId: 23, windowId: 1, task: "Check the page" }, {}, (r) => replies.push(r));
  assert.equal(keepOpen, false);
  assert.deepEqual(replies, [{ ok: true }]);

  // Wait for the fire-and-forget task to finish.
  for (let i = 0; i < 100 && sessionStore["task:23"]?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));

  const state = await new Promise((resolve) => {
    const open = onMessage({ type: "GET_TASK_STATE", tabId: 23 }, {}, (r) => resolve(r.state));
    assert.equal(open, true);
  });
  assert.equal(state.status, "done");
  assert.equal(state.task, "Check the page");
});

// ---------------------------------------------------------------------------
// Safety: questions never act, no invented text, risky clicks need the user's Allow
// ---------------------------------------------------------------------------

const waitForStatus = async (tabId, status) => {
  for (let i = 0; i < 200 && sessionStore[`task:${tabId}`]?.status !== status; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(sessionStore[`task:${tabId}`]?.status, status);
};

test("a question is answered in ask mode: nothing is executed and page PII leaves only as placeholders", async () => {
  const state = await globalThis.odpa.runTask(30, 1, "Analyze this login page");

  assert.equal(state.mode, "ask");
  assert.equal(state.status, "answered", `${state.message}; errors: ${errors()}`);
  assert.equal(state.message, "stub answer");
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION").length, 0, "ask mode never touches the page");
  assert.equal(calls.fetches.length, 1);
  assert.match(calls.fetches[0].url, /\/ask$/);

  const body = calls.fetches[0].body;
  assert.equal(body.task, "Analyze this login page");
  assert.equal(body.pageText, "Sign in to Acme\nEmail [HIDDEN EMAIL]\nPhone [HIDDEN PHONE]\nForgot password?");
  assert.ok(!JSON.stringify(body).includes("jane.doe@example.com"), "raw email appears nowhere in the payload");
  assert.ok(state.hidden.text >= 2);
});

test("the agent may only type text that is in the task: invented credentials are refused", async () => {
  serverScript.push({ action: "type", target: "el_2", text: "hunter2" });
  const state = await globalThis.odpa.runTask(31, 1, "Log in to my account");

  assert.equal(state.status, "needs_user");
  assert.match(state.message, /"hunter2", which is not in your task/);
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION").length, 0, "nothing was typed");
});

test("a risky click waits for the user's Allow, and does nothing when refused", async () => {
  serverScript.push({ action: "click", target: "el_1" }, { action: "done", summary: "Submitted." });
  const running = globalThis.odpa.runTask(32, 1, "Press the submit button");
  await waitForStatus(32, "confirm");
  assert.equal(sessionStore["task:32"].pending, 'Click "Submit"');
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION").length, 0, "nothing happens before Allow");
  assert.ok(calls.badges.includes("?"));

  const replies = [];
  onMessage({ type: "CONFIRM", tabId: 32, allow: true }, {}, (r) => replies.push(r));
  const allowed = await running;
  assert.deepEqual(replies, [{ ok: true }]);
  assert.equal(allowed.status, "done", `${allowed.message}; errors: ${errors()}`);
  assert.equal(allowed.steps[0].confirmed, "user");
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION" && m.command.action === "click").length, 1);

  reset();
  serverScript.push({ action: "click", target: "el_1" });
  const refused = globalThis.odpa.runTask(33, 1, "Press the submit button");
  await waitForStatus(33, "confirm");
  onMessage({ type: "CONFIRM", tabId: 33, allow: false }, {}, () => {});
  const state = await refused;
  assert.equal(state.status, "stopped");
  assert.match(state.message, /^Not allowed: Click "Submit"/);
  assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION").length, 0);
});

test("question detection and typed-text rules", () => {
  const { looksLikeQuestion, textComesFromTask } = globalThis.odpa;
  for (const q of ["analyze this page", "Analyze this login page", "what does this form ask for?", "Summarize the page", "Can you tell me what this page is about"]) {
    assert.equal(looksLikeQuestion(q), true, q);
  }
  for (const t of ["Fill in the contact form with name John Doe", "Can you fill the form with name John", "Log in", "Search for cheap flights", "Click submit"]) {
    assert.equal(looksLikeQuestion(t), false, t);
  }
  assert.equal(textComesFromTask("John Doe", "Fill name John Doe"), true);
  assert.equal(textComesFromTask("Hello from the agent.", "message Hello from the agent then submit"), true);
  assert.equal(textComesFromTask("user123", "log in"), false);
});

// ---------------------------------------------------------------------------
// My info: saved details are typed on-device; only their names leave
// ---------------------------------------------------------------------------

test("saved details: the placeholder becomes the real value on-device and the value never leaves", async () => {
  localStore.profile = [
    { key: "email", label: "Email", value: "aarav.sharma@example.com" },
    { key: "full_name", label: "Full name", value: "Aarav Sharma" },
    { key: "github", label: "GitHub", value: "" },
  ];
  try {
    serverScript.push({ action: "type", target: "el_0", text: "{{email}}" }, { action: "done", summary: "Filled." });
    const state = await globalThis.odpa.runTask(40, 1, "Fill this form with my saved details");
    assert.equal(state.status, "done", `${state.message}; errors: ${errors()}`);

    // The page received the real value, flagged so the field is masked from now on.
    const typed = calls.sent.find((m) => m.type === "EXECUTE_ACTION" && m.command.action === "type");
    assert.equal(typed.command.text, "aarav.sharma@example.com");
    assert.equal(typed.sensitive, true);
    assert.equal(state.steps[0].summary, 'Type the saved Email into "Email"');
    assert.equal(state.person, "Me", "a profile saved before people existed is read as a person called Me");

    // The server received names only (and only for details that have a value).
    assert.deepEqual(calls.fetches[0].body.profileFields, [{ key: "email", label: "Email" }, { key: "full_name", label: "Full name" }]);
    assert.deepEqual(calls.fetches[1].body.history, [{ action: "type", target: "el_0", text: "{{email}}" }]);
    const sent = JSON.stringify(calls.fetches) + JSON.stringify(calls.broadcasts) + JSON.stringify(sessionStore["task:40"]);
    assert.ok(!sent.includes("aarav.sharma@example.com") && !sent.includes("Aarav Sharma"), "saved values appear in no request, broadcast or stored state");

    // A detail that was never saved is not invented: the task stops and asks.
    reset();
    serverScript.push({ action: "type", target: "el_0", text: "{{passport_number}}" });
    const missing = await globalThis.odpa.runTask(41, 1, "Fill this form with my saved details");
    assert.equal(missing.status, "needs_user");
    assert.match(missing.message, /^The form asks for "Email", but "passport_number" is not saved under My info/);
    assert.equal(calls.sent.filter((m) => m.type === "EXECUTE_ACTION").length, 0);
  } finally {
    delete localStore.profile;
  }
});

test("several people: the active person is used unless the task names another saved person", async () => {
  localStore.people = [
    { id: "p1", name: "Me", fields: [{ key: "email", label: "Email", value: "me@example.com" }] },
    { id: "p2", name: "Father", fields: [{ key: "email", label: "Email", value: "father@example.com" }] },
  ];
  localStore.activePersonId = "p1";
  const typedText = () => calls.sent.find((m) => m.type === "EXECUTE_ACTION" && m.command.action === "type").command.text;
  try {
    serverScript.push({ action: "type", target: "el_0", text: "{{email}}" }, { action: "done", summary: "Filled." });
    const mine = await globalThis.odpa.runTask(42, 1, "Fill this form with my saved details");
    assert.equal(typedText(), "me@example.com");
    assert.equal(mine.person, "Me");

    reset();
    serverScript.push({ action: "type", target: "el_0", text: "{{email}}" }, { action: "done", summary: "Filled." });
    const fathers = await globalThis.odpa.runTask(43, 1, "Fill this form with my father's details");
    assert.equal(typedText(), "father@example.com");
    assert.equal(fathers.person, "Father");

    // Switching the active person (the popup's "as" selector) changes who is used.
    reset();
    localStore.activePersonId = "p2";
    serverScript.push({ action: "type", target: "el_0", text: "{{email}}" }, { action: "done", summary: "Filled." });
    await globalThis.odpa.runTask(44, 1, "Fill this form with the saved details");
    assert.equal(typedText(), "father@example.com");
  } finally {
    delete localStore.people;
    delete localStore.activePersonId;
  }
});
