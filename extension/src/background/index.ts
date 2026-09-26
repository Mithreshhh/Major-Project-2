/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 * Orchestrates one "agent step" per click on the toolbar icon:
 *
 *   1. ask the content script for a DOM snapshot            (content/index.ts)
 *   2. capture the visible tab as a screenshot               (only the background can)
 *   3. run on-device perception                              (@odpa/perception/inference)
 *   4. redact sensitive regions in pixels + DOM summary      (@odpa/perception/redaction)
 *   5. build a SanitizedContext and POST it to the server    (api.ts)
 *   6. forward the returned ActionCommand to the content script for execution
 *
 * Everything before step 5 happens on-device. Step 5 is the only network egress.
 */
import {
  loadModel,
  placeholderOutput,
  runInference,
  sanitize,
  type PerceptionOutput,
  type RawImage,
} from "@odpa/perception";
import { PROTOCOL_VERSION, type ActionCommand, type SanitizedContext } from "@odpa/shared";

import { BROWSER, CONFIG } from "../shared/config";
import type { ContentRequest, ContentResponse, DomSnapshot, StepResult } from "../shared/messages";
import { requestAction } from "./api";
import { decodeDataUrl, encodeRawImage } from "./image";

const LOG = "[odpa:bg]";

// ---------------------------------------------------------------------------
// Per-tab session state (lives as long as the worker; persisted to storage on change)
// ---------------------------------------------------------------------------

interface TabSession {
  sessionId: string;
  stepIndex: number;
  history: ActionCommand[];
}

const sessions = new Map<number, TabSession>();
const runningTabs = new Set<number>();

function getSession(tabId: number): TabSession {
  let s = sessions.get(tabId);
  if (!s) {
    s = { sessionId: crypto.randomUUID(), stepIndex: 0, history: [] };
    sessions.set(tabId, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Perception bootstrap
// ---------------------------------------------------------------------------

let perceptionReady: Promise<boolean> | null = null;

function ensurePerception(): Promise<boolean> {
  if (!perceptionReady) {
    perceptionReady = loadModel({
      modelUrl: CONFIG.perception.modelUrl,
      modelId: CONFIG.perception.modelId,
      scoreThreshold: CONFIG.perception.scoreThreshold,
      wasmBaseUrl: chrome.runtime.getURL("ort/"),
      executionProviders: ["wasm"],
      numThreads: 1,
    }).then((loaded) => {
      console.info(LOG, loaded ? `face detector loaded (${CONFIG.perception.modelId})` : "no perception model configured");
      return loaded;
    });
  }
  return perceptionReady;
}

// ---------------------------------------------------------------------------
// Content-script messaging
// ---------------------------------------------------------------------------

async function sendToContent(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  } catch (err) {
    // Typical cause: the tab was open before the extension was (re)loaded, so the declared
    // content script never ran. Inject it once and retry.
    console.warn(LOG, "content script unreachable, injecting", err);
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  }
}

/** PNG of the visible viewport, decoded to RGBA. Only ever called when CONFIG.sendScreenshot is true. */
async function captureScreenshot(windowId?: number): Promise<RawImage> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId as number, { format: "png" });
  return decodeDataUrl(dataUrl);
}

async function captureDom(tabId: number): Promise<DomSnapshot> {
  const res = await sendToContent(tabId, { type: "CAPTURE_DOM" });
  if (res.type !== "DOM_SNAPSHOT") {
    throw new Error(`CAPTURE_DOM failed: ${res.type === "ERROR" ? res.message : res.type}`);
  }
  return res.snapshot;
}

async function executeOnPage(tabId: number, command: ActionCommand) {
  const res = await sendToContent(tabId, { type: "EXECUTE_ACTION", command });
  if (res.type !== "EXECUTION_RESULT") {
    return { ok: false, message: res.type === "ERROR" ? res.message : `unexpected ${res.type}` };
  }
  return res.result;
}

// ---------------------------------------------------------------------------
// The agent step
// ---------------------------------------------------------------------------

export async function runStep(tabId: number, windowId?: number): Promise<StepResult> {
  if (runningTabs.has(tabId)) throw new Error("a step is already running on this tab");
  runningTabs.add(tabId);

  try {
    const session = getSession(tabId);
    const stored = await chrome.storage.local.get("task");
    const task = typeof stored.task === "string" && stored.task ? stored.task : CONFIG.defaultTask;

    // 1. DOM snapshot
    const snapshot = await captureDom(tabId);

    // 2. Screenshot. With sendScreenshot=false this branch is skipped entirely: no
    //    captureVisibleTab, no decode, and (below) no encode and no model load.
    const rawImage: RawImage | null = CONFIG.sendScreenshot ? await captureScreenshot(windowId) : null;

    // 3. On-device perception: UltraFace face detection over the screenshot. No screenshot ->
    //    nothing to detect, so the model is not even loaded.
    let perception: PerceptionOutput;
    if (rawImage) {
      const loaded = await ensurePerception();
      if (!loaded) throw new Error("screenshot captured but no perception model is configured; refusing to continue unredacted");
      perception = await runInference(rawImage);
      console.info(LOG, `perception: ${perception.sensitiveRegions.length} sensitive region(s) in ${perception.latencyMs} ms`);
    } else {
      perception = placeholderOutput();
    }

    // 4. Redaction (pass-through until TODO(redaction) is done)
    const redacted = await sanitize({
      screenshot: rawImage,
      elements: snapshot.elements,
      perception,
      devicePixelRatio: snapshot.viewport.devicePixelRatio,
    });

    // 5. Build the wire payload
    const context: SanitizedContext = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      stepIndex: session.stepIndex,
      task,
      page: snapshot.page,
      viewport: snapshot.viewport,
      elements: redacted.elements,
      screenshot: redacted.screenshot
        ? await encodeRawImage(redacted.screenshot, CONFIG.screenshotMimeType, CONFIG.screenshotQuality)
        : null,
      redactions: redacted.redactions,
      history: session.history,
      perception: {
        modelId: perception.modelId,
        latencyMs: perception.latencyMs,
        // Embedding intentionally omitted from the wire payload for now.
      },
    };

    console.info(LOG, `step ${session.stepIndex} -> /process`, {
      elements: context.elements.length,
      redactions: context.redactions.length,
      screenshotBytes: context.screenshot?.dataBase64.length ?? 0,
    });

    const command = await requestAction(context);
    console.info(LOG, "command", command);

    // 6. Execute on the page
    const execution = await executeOnPage(tabId, command);

    session.history.push(command);
    session.stepIndex += 1;

    return { command, execution, stepIndex: session.stepIndex - 1, sessionId: session.sessionId };
  } finally {
    runningTabs.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.info(LOG, `installed (${BROWSER}), protocol ${PROTOCOL_VERSION}`);
});

/** Small status badge on the toolbar icon so a step is visible without opening DevTools. */
async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Badge is cosmetic; never let it break a step.
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;

  const url = tab.url ?? "";
  if (!/^https?:/i.test(url)) {
    console.warn(LOG, "This tab is not an http(s) page. Open a normal web page and click again.", url || "(no url)");
    await setBadge(tab.id, "!", "#d1242f");
    return;
  }

  await setBadge(tab.id, "...", "#6e7781");
  try {
    const result = await runStep(tab.id, tab.windowId);
    console.info(LOG, "step complete", result);
    await setBadge(tab.id, result.execution.ok ? "OK" : "ERR", result.execution.ok ? "#1a7f37" : "#d1242f");
  } catch (err) {
    console.error(LOG, "step failed", err);
    await setBadge(tab.id, "ERR", "#d1242f");
  }
});

// Forget session state when a tab goes away.
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
});

// Allow other extension surfaces (a future popup/options page) to trigger a step.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "RUN_STEP" &&
    typeof (message as { tabId?: unknown }).tabId === "number"
  ) {
    runStep((message as { tabId: number }).tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }
  return false;
});
