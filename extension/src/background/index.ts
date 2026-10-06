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
  compareWithDom,
  detectUiElements,
  loadModel,
  loadUiDetector,
  placeholderOutput,
  redactText,
  redactTextLabelled,
  runInference,
  sanitize,
  scrubUrl,
  type PerceptionOutput,
  type RawImage,
} from "@odpa/perception";
import { PROTOCOL_VERSION, type ActionCommand, type PerceptionSummary, type SanitizedContext } from "@odpa/shared";

import { BROWSER, CONFIG } from "../shared/config";
import type {
  ContentRequest,
  ContentResponse,
  DomSnapshot,
  PopupRequest,
  StepLog,
  StepResult,
  TaskState,
  Veto,
} from "../shared/messages";
import { describeCommand, looksLikeQuestion, riskyAction, textComesFromTask } from "../shared/messages";
import { getFile, toBase64 } from "../shared/files";
import { hasPlaceholder, loadPeople, pickPerson, profileFieldNames, resolvePlaceholders, type ProfileField } from "../shared/profile";
import { requestAction, requestAnswer } from "./api";
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

let uiDetectorReady: Promise<boolean> | null = null;

/** Loads the UI detector after the face detector (which configures the runtime). Never throws. */
function ensureUiDetector(): Promise<boolean> {
  if (!CONFIG.uiDetector.enabled) return Promise.resolve(false);
  if (!uiDetectorReady) {
    uiDetectorReady = loadUiDetector({
      modelUrl: CONFIG.uiDetector.modelUrl,
      modelId: CONFIG.uiDetector.modelId,
      scoreThreshold: CONFIG.uiDetector.scoreThreshold,
    })
      .then((loaded) => {
        console.info(LOG, `UI detector loaded (${CONFIG.uiDetector.modelId})`);
        return loaded;
      })
      .catch((err: unknown) => {
        console.warn(LOG, "UI detector unavailable, continuing without it", err);
        return false;
      });
  }
  return uiDetectorReady;
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

async function captureDom(tabId: number, includeText = false): Promise<DomSnapshot> {
  const res = await sendToContent(tabId, includeText ? { type: "CAPTURE_DOM", includeText } : { type: "CAPTURE_DOM" });
  if (res.type !== "DOM_SNAPSHOT") {
    throw new Error(`CAPTURE_DOM failed: ${res.type === "ERROR" ? res.message : res.type}`);
  }
  return res.snapshot;
}

async function executeOnPage(tabId: number, command: ActionCommand, sensitive = false) {
  const res = await sendToContent(tabId, sensitive ? { type: "EXECUTE_ACTION", command, sensitive } : { type: "EXECUTE_ACTION", command });
  if (res.type !== "EXECUTION_RESULT") {
    return { ok: false, message: res.type === "ERROR" ? res.message : `unexpected ${res.type}` };
  }
  return res.result;
}

/** Attach a saved file to a file-upload field. The bytes go only to the page, never the server. */
async function uploadOnPage(tabId: number, target: string, file: { name: string; type: string; dataBase64: string }) {
  const res = await sendToContent(tabId, { type: "UPLOAD_FILE", target, file });
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

interface Perceived {
  context: SanitizedContext;
  redactions: StepResult["redactions"];
  perceptionMs: number;
  vision?: StepResult["vision"];
}

/**
 * Capture, detect, redact and build the payload. Everything here happens on the device; the
 * returned context is the only thing that may leave it. `includeText` adds the visible page
 * text (for questions), with personal data replaced by "[HIDDEN EMAIL]"-style placeholders.
 */
async function perceive(
  tabId: number,
  windowId: number | undefined,
  task: string,
  includeText: boolean,
  profile: ProfileField[] = []
): Promise<Perceived> {
  const session = getSession(tabId);

  // 1. DOM snapshot (+ boxes around PII found in page text and typed values)
  const snapshot = await captureDom(tabId, includeText);

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

  // 3b. On-device UI detection from pixels, scored live against the DOM. Must run before
  //     sanitize() zeroes the raw buffer. Optional: a failure here never blocks the step.
  const summary: PerceptionSummary = { modelId: perception.modelId, latencyMs: perception.latencyMs };
  let vision: StepResult["vision"];
  if (rawImage && (await ensureUiDetector())) {
    try {
      const ui = await detectUiElements(rawImage);
      const cmp = compareWithDom(ui.detections, snapshot.elements, snapshot.viewport.devicePixelRatio, snapshot.viewport);
      summary.uiModelId = ui.modelId;
      summary.uiLatencyMs = ui.latencyMs;
      summary.visualElements = cmp.visual;
      vision = { ms: ui.latencyMs, detections: ui.detections.length, domCount: cmp.domCount, found: cmp.found, recall: cmp.recall, precision: cmp.precision };
      console.info(LOG, `vision: ${ui.detections.length} UI element(s) in ${ui.latencyMs} ms, found ${cmp.found}/${cmp.domCount} DOM elements, precision ${cmp.precision}`);
    } catch (err) {
      console.warn(LOG, "UI detection failed, continuing without it", err);
    }
  }

  // 4. Redaction: faces (ml) + password/card fields (dom) + PII text (heuristic) are blacked
  //    out on a fresh copy; `rawImage`'s buffer is zeroed by sanitize(). Labels are scrubbed.
  const redacted = await sanitize({
    screenshot: rawImage,
    elements: snapshot.elements,
    perception,
    textRegions: [...(snapshot.textRegions ?? []), ...(CONFIG.hidePhotos ? (snapshot.imageRegions ?? []) : [])],
    devicePixelRatio: snapshot.viewport.devicePixelRatio,
  });
  const counts = countBy(redacted.redactions.map((r) => (r.category === "photo" ? "photo" : r.method)));
  console.info(
    LOG,
    `redaction: ${redacted.redactions.length} region(s) blacked out (faces ${counts.ml ?? 0}, photos ${counts.photo ?? 0}, fields ${counts.dom ?? 0}, text ${counts.heuristic ?? 0})`
  );

  // 5. Build the wire payload
  const hiddenText = snapshot.pageText ? redactTextLabelled(snapshot.pageText) : null;
  const textHidden = hiddenText ? Object.values(hiddenText.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;
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
    perception: summary,
    ...(hiddenText ? { pageText: hiddenText.text } : {}),
    // Names of the saved details only. The values stay in chrome.storage.local.
    ...(profile.length ? { profileFields: profileFieldNames(profile) } : {}),
  };

  return {
    context,
    redactions: {
      faces: counts.ml ?? 0,
      photos: counts.photo ?? 0,
      fields: counts.dom ?? 0,
      text: Math.max(counts.heuristic ?? 0, textHidden),
    },
    perceptionMs: perception.latencyMs,
    ...(vision ? { vision } : {}),
  };
}

/**
 * Decides whether the model's command may run. Returns a veto to skip it (and end the task with
 * the veto's status), or null to go ahead. May wait for the user (risky-action confirmation).
 */
export type Gate = (command: ActionCommand, context: SanitizedContext) => Veto | null | Promise<Veto | null>;

export async function runStep(
  tabId: number,
  windowId?: number,
  taskOverride?: string,
  gate: Gate = () => null
): Promise<StepResult & { confirmed?: "user" | "auto" }> {
  if (runningTabs.has(tabId)) throw new Error("a step is already running on this tab");
  runningTabs.add(tabId);

  try {
    const session = getSession(tabId);
    const task = taskOverride ?? (await storedTask());
    // Whose details: a saved person named in the task, otherwise the active one.
    const person = pickPerson(task, await loadPeople());
    const profile = (person?.fields ?? []).filter((f) => f.value.trim());
    const { context, redactions, perceptionMs, vision } = await perceive(tabId, windowId, task, false, profile);

    console.info(LOG, `step ${session.stepIndex} -> /process`, {
      elements: context.elements.length,
      redactions: context.redactions.length,
      screenshotBytes: context.screenshot?.dataBase64.length ?? 0,
    });

    const command = await requestAction(context);
    console.info(LOG, "command", command);

    // 6. Saved details: the model answered with a placeholder ("{{email}}"); the real value is
    //    filled in here, on the device. History and logs keep the placeholder, never the value.
    let toExecute = command;
    let savedDetails: string[] = [];
    let missing: Veto | null = null;
    let upload: { name: string; type: string; dataBase64: string } | null = null;
    const who = person && person.name.toLowerCase() !== "me" ? ` for ${person.name}` : "";
    if (command.action === "type") {
      const target = context.elements.find((e) => e.id === command.target);
      const isFileField = target?.attributes?.type === "file";
      const resolved = hasPlaceholder(command.text) ? resolvePlaceholders(command.text, profile) : null;
      if (resolved?.missing.length) {
        missing = {
          status: "needs_user",
          message:
            `The form asks for "${target?.label || command.target}", but "${resolved.missing.join('", "')}" is not saved${who} under My info. ` +
            `Everything that was saved has been filled in. Add the missing detail there, or fill that field yourself.`,
        };
      } else if (isFileField !== Boolean(resolved?.file)) {
        // A file can only go into a file-upload field, and a file-upload field only takes a file.
        missing = {
          status: "needs_user",
          message: isFileField
            ? `"${target?.label || command.target}" needs a file. Save one${who} under My info → Files, then run the task again.`
            : `"${resolved?.file?.label}" is a saved file, but "${target?.label || command.target}" is not a file-upload field.`,
        };
      } else if (resolved?.file) {
        const stored = resolved.file.fileId ? await getFile(resolved.file.fileId).catch(() => undefined) : undefined;
        if (!stored) {
          missing = { status: "needs_user", message: `The saved file "${resolved.file.label}" could not be read. Add it again under My info → Files.` };
        } else {
          upload = { name: stored.name, type: stored.type, dataBase64: toBase64(stored.bytes) };
          savedDetails = resolved.used;
        }
      } else if (resolved) {
        toExecute = { ...command, text: resolved.text };
        savedDetails = resolved.used;
      }
    }

    // 7. Execute on the page, unless the gate vetoes it
    const veto = missing ?? (await gate(command, context));
    const execution = veto
      ? { ok: true, message: `not executed: ${veto.message}` }
      : upload
        ? await uploadOnPage(tabId, (command as { target: string }).target, upload)
        : await executeOnPage(tabId, toExecute, savedDetails.length > 0);

    session.history.push(command);
    session.stepIndex += 1;
    const targetLabel = "target" in command ? context.elements.find((e) => e.id === command.target)?.label : undefined;

    return {
      command,
      execution,
      skipped: veto !== null,
      ...(veto ? { veto } : {}),
      ...(targetLabel ? { targetLabel } : {}),
      ...(savedDetails.length ? { savedDetails, ...(person ? { person: person.name } : {}) } : {}),
      ...(upload ? { attached: true } : {}),
      stepIndex: session.stepIndex - 1,
      sessionId: session.sessionId,
      redactions,
      perceptionMs,
      ...(vision ? { vision } : {}),
    };
  } finally {
    runningTabs.delete(tabId);
  }
}

/**
 * Ask mode: answer a question about the page. Read-only by construction: the server returns
 * text, and nothing here can execute anything on the page.
 */
export async function runAsk(tabId: number, windowId: number | undefined, question: string): Promise<TaskState> {
  const current = tasks.get(tabId);
  if (current?.status === "running" || current?.status === "confirm") return current;
  if (runningTabs.has(tabId)) throw new Error("a step is already running on this tab");

  resetSession(tabId);
  await chrome.storage.local.set?.({ task: question });
  const state: TaskState = { tabId, task: question, mode: "ask", status: "running", steps: [], maxSteps: 1, startedAt: Date.now() };
  await publish(state);
  await setBadge(tabId, "?", "#6e7781");

  runningTabs.add(tabId);
  try {
    const { context, redactions } = await perceive(tabId, windowId, question, true);
    console.info(LOG, "ask -> /ask", { textChars: context.pageText?.length ?? 0, redactions: context.redactions.length });
    state.hidden = redactions;
    state.message = await requestAnswer(context);
    state.status = "answered";
  } catch (err) {
    console.error(LOG, "ask failed", err);
    state.status = "failed";
    state.message = err instanceof Error ? err.message : String(err);
  } finally {
    runningTabs.delete(tabId);
  }

  state.finishedAt = Date.now();
  await publish(state);
  await setBadge(tabId, state.status === "answered" ? "OK" : "ERR", state.status === "answered" ? "#1a7f37" : "#d1242f");
  return state;
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

/** Resolvers for risky actions waiting on the user's Allow / Stop in the popup. */
const confirmations = new Map<number, (allow: boolean) => void>();
const CONFIRM_TIMEOUT_MS = 120_000;

function waitForConfirmation(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
    const settle = (allow: boolean) => {
      clearTimeout(timer);
      confirmations.delete(tabId);
      resolve(allow);
    };
    confirmations.set(tabId, settle);
  });
}

export function confirmAction(tabId: number, allow: boolean): boolean {
  const settle = confirmations.get(tabId);
  settle?.(allow);
  return settle !== undefined;
}

export interface TaskOptions {
  maxSteps?: number;
  /** Allow risky actions without asking (automated runs only). */
  autoConfirm?: boolean;
  /** "auto" (default) answers question-like tasks in ask mode; "act" always works on the page. */
  mode?: "auto" | "act";
}

/**
 * Run `task` on the tab until it finishes. Resolves with the final state; never throws (a
 * failure becomes status "failed" with a message).
 *
 * Safety, in order: questions go to ask mode and never act; a repeated action is refused; the
 * agent may only type text found in the task; risky clicks (log in, submit, pay, delete, send)
 * wait for the user's Allow in the popup.
 */
export async function runTask(
  tabId: number,
  windowId: number | undefined,
  task: string,
  options: TaskOptions | number = {}
): Promise<TaskState> {
  const opts: TaskOptions = typeof options === "number" ? { maxSteps: options } : options;
  const maxSteps = opts.maxSteps ?? CONFIG.maxTaskSteps;
  if ((opts.mode ?? "auto") === "auto" && looksLikeQuestion(task)) return runAsk(tabId, windowId, task);

  const current = tasks.get(tabId);
  if (current?.status === "running" || current?.status === "confirm") return current;

  stopRequested.delete(tabId);
  resetSession(tabId);
  await chrome.storage.local.set?.({ task });

  const state: TaskState = { tabId, task, mode: "act", status: "running", steps: [], maxSteps, startedAt: Date.now() };
  await publish(state);

  let previous: ActionCommand | undefined;
  let confirmed: "user" | "auto" | undefined;
  const gate: Gate = async (command, context) => {
    confirmed = undefined;
    if (sameCommand(previous, command)) {
      return { status: "stopped", message: "The agent proposed the same action twice in a row; it was not repeated and the task was stopped." };
    }
    // Placeholders for saved details are allowed: runStep has already checked they exist.
    if (command.action === "type" && !hasPlaceholder(command.text) && !textComesFromTask(command.text, task)) {
      return {
        status: "needs_user",
        message: `The agent wanted to type "${command.text}", which is not in your task, so nothing was typed. Tell it exactly what to enter.`,
      };
    }
    const risk = riskyAction(command, context);
    if (!risk) return null;
    if (opts.autoConfirm) {
      confirmed = "auto";
      return null;
    }
    state.status = "confirm";
    state.pending = risk;
    await publish(state);
    await setBadge(tabId, "?", "#9a6700");
    const allow = await waitForConfirmation(tabId);
    state.status = "running";
    delete state.pending;
    await publish(state);
    if (!allow) return { status: "stopped", message: `Not allowed: ${risk}. Nothing was done.` };
    confirmed = "user";
    return null;
  };

  try {
    for (let i = 0; i < maxSteps; i++) {
      if (stopRequested.has(tabId)) {
        state.status = "stopped";
        state.message = "Stopped by you.";
        break;
      }

      await setBadge(tabId, `${i + 1}`, "#6e7781");
      const started = Date.now();
      const result = await runStep(tabId, windowId, task, gate);
      const log: StepLog = {
        index: i,
        summary: describeCommand(result.command, result.targetLabel, result.savedDetails, result.attached),
        command: result.command,
        ok: result.execution.ok && !result.skipped,
        message: result.execution.message,
        redactions: result.redactions,
        ms: Date.now() - started,
        ...(result.vision ? { vision: result.vision } : {}),
        ...(confirmed ? { confirmed } : {}),
      };
      if (result.person) state.person = result.person;
      state.steps.push(log);
      await publish(state);

      const action = result.command.action;
      if (result.veto) {
        state.status = result.veto.status;
        state.message = result.veto.message;
        break;
      }
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
 * Only fires when no popup is configured (the popup normally takes the click), so it is not
 * reachable from the toolbar in this build. Kept as a one-step fallback for the bundle tests;
 * it has no confirmation UI, so real use goes through the popup and runTask's safety gate.
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
      void runTask(msg.tabId, msg.windowId, msg.task, { maxSteps: msg.maxSteps });
      sendResponse({ ok: true });
      return false;
    case "ASK":
      void runAsk(msg.tabId, msg.windowId, msg.question).catch((err: unknown) => console.error(LOG, "ask failed", err));
      sendResponse({ ok: true });
      return false;
    case "CONFIRM":
      sendResponse({ ok: confirmAction(msg.tabId, msg.allow) });
      return false;
    case "STOP_TASK":
      stopRequested.add(msg.tabId);
      confirmAction(msg.tabId, false); // a pending "Allow?" counts as refused
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
(globalThis as unknown as { odpa: unknown }).odpa = {
  runTask,
  runAsk,
  runStep,
  getTaskState,
  confirmAction,
  looksLikeQuestion,
  textComesFromTask,
};
