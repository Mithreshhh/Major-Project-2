/**
 * Smoke test of one agent step, run against the BUILT Chrome bundle with a stubbed chrome.* API
 * and a stubbed fetch. No browser needed.
 *
 * Guards the sendScreenshot=false contract: captureVisibleTab is never called, no image is
 * decoded or encoded, and the /process payload carries `screenshot: null`.
 *
 *   npm run build && npm test        (from extension/)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "dist/chrome/background.js");
const configSource = readFileSync(path.join(root, "src/shared/config.ts"), "utf8");
const screenshotsEnabled = /sendScreenshot:\s*true\b/.test(configSource);

const snapshot = {
  page: { url: "http://127.0.0.1:5500/", title: "Agent test page", capturedAt: new Date().toISOString() },
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  elements: [
    { id: "el_0", role: "textbox", label: "Email", bbox: { x: 100, y: 200, width: 300, height: 32 }, isVisible: true, isInteractive: true },
    { id: "el_1", role: "button", label: "Submit", bbox: { x: 100, y: 260, width: 120, height: 40 }, isVisible: true, isInteractive: true },
  ],
};

// ---------------------------------------------------------------------------
// Stubs (installed once; the bundle registers its listeners against them)
// ---------------------------------------------------------------------------

const calls = { capture: 0, badges: [], sent: [], fetches: [], logs: [] };
let onClicked = null;

function reset() {
  calls.capture = 0;
  calls.badges.length = 0;
  calls.sent.length = 0;
  calls.fetches.length = 0;
  calls.logs.length = 0;
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
      return "data:image/png;base64,iVBORw0KGgo=";
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

globalThis.fetch = async (url, init) => {
  calls.fetches.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  "one step with sendScreenshot=false captures, decodes, encodes and sends no pixels",
  { skip: screenshotsEnabled && "sendScreenshot is true in config.ts; this test covers the off state" },
  async () => {
    await onClicked({ id: 7, windowId: 1, url: "http://127.0.0.1:5500/" });

    assert.equal(calls.capture, 0, "captureVisibleTab must not be called");
    assert.equal(calls.fetches.length, 1, `expected only the /process POST, got ${JSON.stringify(calls.fetches.map((f) => f.url))}`);

    const [request] = calls.fetches;
    assert.ok(request.url.endsWith("/process"), request.url);
    assert.equal(request.body.screenshot, null);
    assert.equal(request.body.perception.modelId, "placeholder");
    assert.equal(request.body.elements.length, snapshot.elements.length);
    assert.equal(request.body.redactions.length, 0);

    assert.deepEqual(calls.sent.map((m) => m.type), ["CAPTURE_DOM", "EXECUTE_ACTION"]);
    assert.equal(calls.sent[1].command.target, "el_1");
    assert.equal(calls.badges.at(-1), "OK", `badges: ${calls.badges.join(" -> ")}`);
    assert.ok(!calls.logs.some(([level]) => level === "error"), JSON.stringify(calls.logs));
  }
);

test("clicking on a non-http tab does nothing but flag the badge", async () => {
  await onClicked({ id: 8, windowId: 1, url: "chrome://newtab/" });

  assert.equal(calls.capture, 0);
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.deepEqual(calls.badges, ["!"]);
});

test("a second step on the same tab carries the first command in history", { skip: screenshotsEnabled }, async () => {
  await onClicked({ id: 9, windowId: 1, url: "http://127.0.0.1:5500/" });
  await onClicked({ id: 9, windowId: 1, url: "http://127.0.0.1:5500/" });

  assert.equal(calls.fetches.length, 2);
  assert.equal(calls.fetches[0].body.stepIndex, 0);
  assert.equal(calls.fetches[1].body.stepIndex, 1);
  assert.deepEqual(calls.fetches[1].body.history, [{ action: "click", target: "el_1", reasoning: "stub" }]);
  assert.equal(calls.capture, 0);
});
