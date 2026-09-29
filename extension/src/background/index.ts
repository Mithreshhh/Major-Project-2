/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 * One agent STEP:
 *   1. ask the content script for a DOM snapshot + PII boxes      (content/index.ts)
 *   2. capture the visible tab as a screenshot                    (only the background can)
 *   3. run on-device face detection                               (@odpa/perception)
 *   4. black out faces, sensitive fields and PII text; scrub labels, URL and title
 *   5. build a SanitizedContext and POST it to the server         (api.ts)
 *   6. forward the returned ActionCommand to the content script for execution
 *
 * One agent TASK (from the popup): repeat steps until the model says "done" or "ask_user",
 * the page cannot be acted on, the agent repeats itself, or the step limit is reached.
 *
 * Everything before step 5 happens on-device. Step 5 is the only network egress.
 */
import {
  loadModel,
  placeholderOutput,
  redactText,
  runInference,
  sanitize,
  scrubUrl,
  type PerceptionOutput,
  type RawImage,
} from "@odpa/perception";
import { PROTOCOL_VERSION, type ActionCommand, type SanitizedContext } from "@odpa/shared";

import { BROWSER, CONFIG } from "../shared/config";
import type {
  ContentRequest,
  ContentResponse,
  DomSnapshot,
  PopupRequest,
  StepLog,
  StepResult,
  TaskState,
} from "../shared/messages";
import { describeCommand } from "../shared/messages";
import { requestAction } from "./api";
import { decodeDataUrl, encodeRawImage } from "./image";

const LOG = "[odpa:bg]";

// ---------------------------------------------------------------------------
// Per-tab session state
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

function resetSession(tabId: number): TabSession {
  const s = { sessionId: crypto.randomUUID(), stepIndex: 0, history: [] };
  sessions.set(tabId, s);
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
      // Must be the exact .wasm the bundled glue expects (see scripts/build.mjs alias).
      wasmUrl: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.wasm"),
      executionProviders: ["wasm"],
      numThreads: 1,
    })
      .then((loaded) => {
        console.info(LOG, loaded ? `face detector loaded (${CONFIG.perception.modelId})` : "no perception model configured");
        return loaded;
      })
      .catch((err: unknown) => {
        perceptionReady = null; // allow a retry on the next step
        throw err;
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
// One agent step
// ---------------------------------------------------------------------------

async function storedTask(): Promise<string> {
  const stored = await chrome.storage.local.get("task");
  return typeof stored.task === "string" && stored.task ? stored.task : CONFIG.defaultTask;
}

export async function runStep(
  tabId: number,
  windowId?: number,
  taskOverride?: string,
  /** Return false to skip executing the returned command (used to refuse repeated actions). */
  shouldExecute: (command: ActionCommand) => boolean = () => true
): Promise<StepResult> {
  if (runningTabs.has(tabId)) throw new Error("a step is already running on this tab");
  runningTabs.add(tabId);

  try {
    const session = getSession(tabId);
    const task = taskOverride ?? (await storedTask());

    // 1. DOM snapshot (+ boxes around PII found in page text and typed values)
    const snapshot = await captureDom(tabId);

    // 2. Screenshot. With sendScreenshot=false this branch is skipped entirely.
    const rawImage: RawImage | null = CONFIG.sendScreenshot ? await captureScreenshot(windowId) : null;

    // 3. On-device face detection. No screenshot -> nothing to detect, model not loaded.
    let perception: PerceptionOutput;
    if (rawImage) {
      const loaded = await ensurePerception();
      if (!loaded) throw new Error("screenshot captured but no perception model is configured; refusing to continue unredacted");
      perception = await runInference(rawImage);
    } else {
      perception = placeholderOutput();
    }

    // 4. Redaction: faces (ml) + password/card fields (dom) + PII text (heuristic) are blacked
    //    out on a fresh copy; `rawImage`'s buffer is zeroed by sanitize(). Labels are scrubbed.
    const redacted = await sanitize({
      screenshot: rawImage,
      elements: snapshot.elements,
      perception,
      textRegions: snapshot.textRegions ?? [],
      devicePixelRatio: snapshot.viewport.devicePixelRatio,
    });
    const counts = countBy(redacted.redactions.map((r) => r.method));
    console.info(
      LOG,
      `redaction: ${redacted.redactions.length} region(s) blacked out (faces ${counts.ml ?? 0}, fields ${counts.dom ?? 0}, text ${counts.heuristic ?? 0})`
    );

    // 5. Build the wire payload
    const context: SanitizedContext = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      stepIndex: session.stepIndex,
      task,
      page: {
        ...snapshot.page,
        url: scrubUrl(snapshot.page.url),
        title: redactText(snapshot.page.title).text,
      },
      viewport: snapshot.viewport,
      elements: redacted.elements,
      screenshot: redacted.screenshot
        ? await encodeRawImage(redacted.screenshot, CONFIG.screenshotMimeType, CONFIG.screenshotQuality)
        : null,
      redactions: redacted.redactions,
      history: session.history,
      perception: { modelId: perception.modelId, latencyMs: perception.latencyMs },
    };

    console.info(LOG, `step ${session.stepIndex} -> /process`, {
      elements: context.elements.length,
      redactions: context.redactions.length,
      screenshotBytes: context.screenshot?.dataBase64.length ?? 0,
    });

    const command = await requestAction(context);
    console.info(LOG, "command", command);

    // 6. Execute on the page (unless the caller vetoes it)
    const skipped = !shouldExecute(command);
    const execution = skipped ? { ok: true, message: "not executed: same as the previous action" } : await executeOnPage(tabId, command);

    session.history.push(command);
    session.stepIndex += 1;

    return {
      command,
      execution,
      skipped,
      stepIndex: session.stepIndex - 1,
      sessionId: session.sessionId,
      redactions: { faces: counts.ml ?? 0, fields: counts.dom ?? 0, text: counts.heuristic ?? 0 },
      perceptionMs: perception.latencyMs,
    };
  } finally {
    runningTabs.delete(tabId);
  }
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Multi-step task
// ---------------------------------------------------------------------------

const tasks = new Map<number, TaskState>();
const stopRequested = new Set<number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sameCommand(a: ActionCommand | undefined, b: ActionCommand): boolean {
  if (!a || a.action !== b.action) return false;
  return JSON.stringify({ ...a, reasoning: undefined, confidence: undefined }) === JSON.stringify({ ...b, reasoning: undefined, confidence: undefined });
}

async function publish(live: TaskState): Promise<void> {
  tasks.set(live.tabId, live);
  const state = structuredClone(live); // a point-in-time snapshot, never the object we keep mutating
  try {
    await chrome.storage.session?.set({ [`task:${state.tabId}`]: state });
  } catch {
    // storage.session is a convenience for re-opened popups; in-memory state is authoritative.
  }
  try {
    await chrome.runtime.sendMessage?.({ type: "TASK_UPDATE", state });
  } catch {
    // No popup open to receive it. Fine.
  }
}

export async function getTaskState(tabId: number): Promise<TaskState | null> {
  const mem = tasks.get(tabId);
  if (mem) return mem;
  try {
    const stored = await chrome.storage.session?.get(`task:${tabId}`);
    return (stored?.[`task:${tabId}`] as TaskState | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `task` on the tab until it finishes. Resolves with the final state; never throws (a
 * failure becomes status "failed" with a message).
 */
export async function runTask(
  tabId: number,
  windowId: number | undefined,
  task: string,
  maxSteps: number = CONFIG.maxTaskSteps
): Promise<TaskState> {
  const current = tasks.get(tabId);
  if (current?.status === "running") return current;

  stopRequested.delete(tabId);
  resetSession(tabId);
  await chrome.storage.local.set?.({ task });

  const state: TaskState = { tabId, task, status: "running", steps: [], maxSteps, startedAt: Date.now() };
  await publish(state);

  let previous: ActionCommand | undefined;
  try {
    for (let i = 0; i < maxSteps; i++) {
      if (stopRequested.has(tabId)) {
        state.status = "stopped";
        state.message = "Stopped by you.";
        break;
      }

      await setBadge(tabId, `${i + 1}`, "#6e7781");
      const started = Date.now();
      const result = await runStep(tabId, windowId, task, (command) => !sameCommand(previous, command));
      const log: StepLog = {
        index: i,
        summary: describeCommand(result.command),
        command: result.command,
        ok: result.execution.ok,
        message: result.execution.message,
        redactions: result.redactions,
        ms: Date.now() - started,
      };
      state.steps.push(log);
      await publish(state);

      const action = result.command.action;
      if (!result.execution.ok) {
        state.status = "failed";
        state.message = result.execution.message ?? "The action could not be performed on the page.";
        break;
      }
      if (action === "done") {
        state.status = "done";
        state.message = result.command.summary;
        break;
      }
      if (action === "ask_user") {
        state.status = "needs_user";
        state.message = result.command.question;
        break;
      }
      if (action === "noop") {
        state.status = "stopped";
        state.message = result.command.reason;
        break;
      }
      if (result.skipped) {
        state.status = "stopped";
        state.message = "The agent proposed the same action twice in a row; it was not repeated and the task was stopped.";
        break;
      }
      previous = result.command;
      await sleep(CONFIG.stepDelayMs);
    }
    if (state.status === "running") {
      state.status = "max_steps";
      state.message = `Stopped after ${maxSteps} steps.`;
    }
  } catch (err) {
    console.error(LOG, "task failed", err);
    state.status = "failed";
    state.message = err instanceof Error ? err.message : String(err);
  }

  state.finishedAt = Date.now();
  await publish(state);
  const ok = state.status === "done";
  await setBadge(tabId, ok ? "OK" : state.status === "failed" ? "ERR" : "||", ok ? "#1a7f37" : state.status === "failed" ? "#d1242f" : "#9a6700");
  return state;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.info(LOG, `installed (${BROWSER}), protocol ${PROTOCOL_VERSION}`);
});

/** Small status badge on the toolbar icon so progress is visible without opening anything. */
async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Badge is cosmetic; never let it break a step.
  }
}

/**
 * Only fires when no popup is configured (the popup normally takes the click). Kept as a
 * one-step fallback and for the bundle tests.
 */
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
  tasks.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const msg = message as PopupRequest;

  switch (msg.type) {
    case "RUN_TASK":
      // Fire and forget: progress arrives via TASK_UPDATE broadcasts.
      void runTask(msg.tabId, msg.windowId, msg.task, msg.maxSteps);
      sendResponse({ ok: true });
      return false;
    case "STOP_TASK":
      stopRequested.add(msg.tabId);
      sendResponse({ ok: true });
      return false;
    case "GET_TASK_STATE":
      getTaskState(msg.tabId).then((state) => sendResponse({ ok: true, state }));
      return true;
    case "RUN_STEP":
      runStep(msg.tabId, msg.windowId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    default:
      return false;
  }
});

// Handle for automated end-to-end runs and DevTools: `await odpa.runTask(tabId, windowId, "...")`.
(globalThis as unknown as { odpa: unknown }).odpa = { runTask, runStep, getTaskState };
