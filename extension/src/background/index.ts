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
  loadOcr,
  loadUiDetector,
  placeholderOutput,
  readText,
  redactText,
  redactTextLabelled,
  runInference,
  sanitize,
  scrubUrl,
  sensitiveOcrText,
  visionOnlyCandidates,
  type PerceptionOutput,
  type RawImage,
} from "@odpa/perception";
import {
  PROTOCOL_VERSION,
  type ActionCommand,
  type BoundingBox,
  type PerceptionSummary,
  type RedactedRegion,
  type SanitizedContext,
  type UIElement,
  type VisualElement,
} from "@odpa/shared";

import { BROWSER, CONFIG } from "../shared/config";
import type {
  ContentRequest,
  ContentResponse,
  DomSnapshot,
  FrameInfo,
  InputAnswer,
  InputRequest,
  PointProbe,
  PopupRequest,
  StepLog,
  StepResult,
  TaskState,
  Veto,
} from "../shared/messages";
import { describeCommand, looksLikeQuestion, riskyAction, textComesFromTask } from "../shared/messages";
import { getFile, toBase64 } from "../shared/files";
import {
  hasPlaceholder,
  loadPeople,
  newId,
  pickPerson,
  profileFieldNames,
  resolvePlaceholders,
  savePeople,
  toKey,
  type ProfileField,
} from "../shared/profile";
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

let ocrReady: Promise<boolean> | null = null;

/** Loads the OCR models on first need (most pages never need them). Never throws. */
function ensureOcr(): Promise<boolean> {
  if (!CONFIG.ocr.enabled) return Promise.resolve(false);
  if (!ocrReady) {
    ocrReady = loadOcr({ detModelUrl: CONFIG.ocr.detModelUrl, recModelUrl: CONFIG.ocr.recModelUrl, modelId: CONFIG.ocr.modelId })
      .then((loaded) => {
        console.info(LOG, `OCR loaded (${CONFIG.ocr.modelId})`);
        return loaded;
      })
      .catch((err: unknown) => {
        console.warn(LOG, "OCR unavailable", err);
        ocrReady = null; // allow a retry on the next step
        return false;
      });
  }
  return ocrReady;
}

// ---------------------------------------------------------------------------
// Content-script messaging
// ---------------------------------------------------------------------------

/**
 * Message the content script of one frame (0: the top page). The script runs in every frame, so
 * a message without a frame id would reach all of them and the first reply would win.
 */
async function sendToContent(tabId: number, request: ContentRequest, frameId = 0): Promise<ContentResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, request, { frameId })) as ContentResponse;
  } catch (err) {
    // Typical cause: the tab was open before the extension was (re)loaded, so the declared
    // content script never ran. Inject it once and retry.
    console.warn(LOG, "content script unreachable, injecting", err);
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    return (await chrome.tabs.sendMessage(tabId, request, { frameId })) as ContentResponse;
  }
}

// ---------------------------------------------------------------------------
// Embedded frames
// ---------------------------------------------------------------------------

/** FRAME_HELLO answers by nonce: which frame of which tab got that nonce. */
const hellos = new Map<string, { tabId: number; frameId: number }>();
const helloWaiters = new Map<string, (frame: { tabId: number; frameId: number }) => void>();

function frameHello(nonce: string, tabId: number, frameId: number): void {
  const waiter = helloWaiters.get(nonce);
  if (waiter) waiter({ tabId, frameId });
  else if (hellos.size < 256) hellos.set(nonce, { tabId, frameId });
}

/** The frame that answered `nonce`, or null when nothing answered in time (no script in there). */
function waitForHello(nonce: string, tabId: number, ms = 400): Promise<number | null> {
  const known = hellos.get(nonce);
  if (known) {
    hellos.delete(nonce);
    return Promise.resolve(known.tabId === tabId ? known.frameId : null);
  }
  return new Promise((resolve) => {
    const done = (frame: { tabId: number; frameId: number } | null) => {
      clearTimeout(timer);
      helloWaiters.delete(nonce);
      resolve(frame && frame.tabId === tabId ? frame.frameId : null);
    };
    const timer = setTimeout(() => done(null), ms);
    helloWaiters.set(nonce, done);
  });
}

/**
 * Per tab, frame id -> n, for element ids "el_f<n>_<k>". Stable for the tab's lifetime, so the
 * history ("clicked el_f1_4") keeps pointing at the same control from step to step.
 */
const frameNumbers = new Map<number, Map<number, number>>();

function frameNumber(tabId: number, frameId: number): number {
  let numbers = frameNumbers.get(tabId);
  if (!numbers) frameNumbers.set(tabId, (numbers = new Map()));
  let n = numbers.get(frameId);
  if (n === undefined) numbers.set(frameId, (n = numbers.size + 1));
  return n;
}

/** The frame an element id lives in: 0 for "el_7", the frame id for "el_f2_7". */
function frameOf(tabId: number, elementId: string): number {
  const n = Number(/^el_f(\d+)_/.exec(elementId)?.[1] ?? 0);
  if (!n) return 0;
  for (const [frameId, number] of frameNumbers.get(tabId) ?? []) if (number === n) return frameId;
  return 0;
}

const intersect = (a: BoundingBox, b: BoundingBox): BoundingBox | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
};

/**
 * Brings the content of embedded frames into the top page's snapshot: each frame whose content
 * script answered is asked for its own snapshot, which is moved to the frame's position and cut
 * to its visible part. Elements, PII boxes, photos and (for questions) text join the page's own.
 * Returns the frames nobody could read from the inside, for OCR.
 */
async function mergeFrames(tabId: number, snapshot: DomSnapshot, includeText: boolean): Promise<BoundingBox[]> {
  const unread: BoundingBox[] = [];
  for (const frame of snapshot.frames ?? []) {
    const frameId = frame.nonce ? await waitForHello(frame.nonce, tabId) : null;
    if (frameId === null) {
      unread.push(frame.bbox);
      continue;
    }
    let inner: DomSnapshot;
    try {
      const res = await sendToContent(tabId, { type: "CAPTURE_DOM", includeText, frame: frameNumber(tabId, frameId) }, frameId);
      if (res.type !== "DOM_SNAPSHOT") throw new Error(res.type === "ERROR" ? res.message : res.type);
      inner = res.snapshot;
    } catch (err) {
      console.warn(LOG, "an embedded frame did not answer, reading it from pixels instead", err);
      unread.push(frame.bbox);
      continue;
    }
    const move = (b: BoundingBox): BoundingBox => ({ ...b, x: b.x + frame.origin.x, y: b.y + frame.origin.y });
    // In reading order: before the first page element below the frame (a small model works
    // through the list in order, so the payment box's Pay must come before "Place order" under it).
    const bottom = frame.bbox.y + frame.bbox.height;
    const at = snapshot.elements.findIndex((e) => e.bbox.y >= bottom);
    const moved = inner.elements.map((e) => {
      const bbox = move(e.bbox);
      return { ...e, bbox, isVisible: e.isVisible && intersect(bbox, frame.bbox) !== null, attributes: { ...e.attributes, frame: "embedded" } };
    });
    snapshot.elements.splice(at < 0 ? snapshot.elements.length : at, 0, ...moved);
    const cut = (r: RedactedRegion): RedactedRegion[] => {
      const bbox = intersect(move(r.bbox), frame.bbox);
      return bbox ? [{ ...r, bbox }] : [];
    };
    snapshot.textRegions.push(...inner.textRegions.flatMap(cut));
    snapshot.imageRegions = [...(snapshot.imageRegions ?? []), ...(inner.imageRegions ?? []).flatMap(cut)];
    if (includeText && inner.pageText) snapshot.pageText = `${snapshot.pageText ?? ""}\n\n[Text inside an embedded frame]\n${inner.pageText}`;
    // Frames inside this frame are not entered (one level deep): read those from pixels.
    for (const nested of inner.frames ?? []) {
      const bbox = intersect(move(nested.bbox), frame.bbox);
      if (bbox) unread.push(bbox);
    }
  }
  return unread;
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
  // A copy: embedded frames' elements and boxes are added to these lists later in the step.
  const s = res.snapshot;
  return { ...s, elements: [...s.elements], textRegions: [...s.textRegions], ...(s.imageRegions ? { imageRegions: [...s.imageRegions] } : {}) };
}

async function executeOnPage(tabId: number, command: ActionCommand, sensitive = false) {
  const frameId = "target" in command ? frameOf(tabId, command.target) : 0;
  const res = await sendToContent(tabId, sensitive ? { type: "EXECUTE_ACTION", command, sensitive } : { type: "EXECUTE_ACTION", command }, frameId);
  if (res.type !== "EXECUTION_RESULT") {
    return { ok: false, message: res.type === "ERROR" ? res.message : `unexpected ${res.type}` };
  }
  return res.result;
}

/** Attach a saved file to a file-upload field. The bytes go only to the page, never the server. */
async function uploadOnPage(tabId: number, target: string, file: { name: string; type: string; dataBase64: string }) {
  const res = await sendToContent(tabId, { type: "UPLOAD_FILE", target, file }, frameOf(tabId, target));
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

const toScreenPx = (b: BoundingBox, dpr: number): BoundingBox => ({ x: b.x * dpr, y: b.y * dpr, width: b.width * dpr, height: b.height * dpr });
const toCssPx = (b: BoundingBox, dpr: number): BoundingBox => ({ x: b.x / dpr, y: b.y / dpr, width: b.width / dpr, height: b.height / dpr });

/** Placeholders for personal data in text read from pixels, worded like the page-text ones. */
const OCR_PLACEHOLDER: Partial<Record<RedactedRegion["category"], string>> = {
  payment_card: "[HIDDEN CARD NUMBER]",
  email: "[HIDDEN EMAIL]",
  phone: "[HIDDEN PHONE]",
  pii_text: "[HIDDEN NUMBER]",
};

/** What OCR did this step, for the payload summary. */
interface OcrStats {
  ms: number;
  lines: number;
}

/**
 * Embedded frames: the content script cannot read their text, so it is read here from the raw
 * screenshot, on the device. Lines with personal data become redaction regions (CSS px) and are
 * replaced by placeholders in the frame text returned for ask mode. Fails closed: a frame that
 * cannot be read is hidden whole.
 */
async function readFrames(raw: RawImage, frames: BoundingBox[], dpr: number, stats: OcrStats): Promise<{ regions: RedactedRegion[]; text: string[] }> {
  const whole = (bbox: BoundingBox): RedactedRegion => ({ bbox, category: "other", confidence: 1, method: "ocr" });
  if (!frames.length) return { regions: [], text: [] };
  if (!(await ensureOcr())) return { regions: frames.map(whole), text: [] };
  const regions: RedactedRegion[] = [];
  const text: string[] = [];
  for (const frame of frames) {
    try {
      const out = await readText(raw, toScreenPx(frame, dpr));
      stats.ms += out.latencyMs;
      stats.lines += out.lines.length;
      const lines: string[] = [];
      for (const line of out.lines) {
        const category = sensitiveOcrText(line.text);
        if (category) regions.push({ bbox: toCssPx(line.bbox, dpr), category, confidence: line.confidence, method: "ocr" });
        // The whole line goes: an OCR slip can defeat the normal text rules applied later.
        lines.push(category ? (OCR_PLACEHOLDER[category] ?? "[HIDDEN PERSONAL DATA]") : line.text);
      }
      if (lines.length) text.push(lines.join("\n"));
    } catch (err) {
      console.warn(LOG, "could not read a frame, hiding it whole", err);
      regions.push(whole(frame));
    }
  }
  console.info(LOG, `OCR: ${frames.length} frame(s), ${stats.lines} line(s), ${regions.length} hidden, ${stats.ms} ms`);
  return { regions, text };
}

/** Text of a control drawn in pixels (a canvas or an image of a button), read on the device. */
async function readControlLabel(raw: RawImage, bbox: BoundingBox, dpr: number, stats: OcrStats): Promise<string> {
  if (!(await ensureOcr())) return "";
  try {
    const out = await readText(raw, toScreenPx(bbox, dpr));
    stats.ms += out.latencyMs;
    stats.lines += out.lines.length;
    return out.lines.map((l) => l.text).join(" ").slice(0, 80);
  } catch (err) {
    console.warn(LOG, "could not read a control's text", err);
    return "";
  }
}

/**
 * Controls only the vision model found: boxes no listed element covers, checked by the content
 * script (is the page under them clickable?) and returned as "vis_N" elements, to be sanitized with
 * the DOM's own elements so their labels go through the same redaction. Marks their vision boxes.
 */
async function visionOnlyElements(
  tabId: number,
  visual: VisualElement[],
  snapshot: DomSnapshot,
  raw: RawImage,
  ocr: OcrStats
): Promise<UIElement[]> {
  const candidates = visionOnlyCandidates(visual, snapshot.elements, snapshot.viewport, {
    minConfidence: CONFIG.uiDetector.visionOnlyMinConfidence,
  });
  if (!candidates.length) return [];
  let probes: PointProbe[];
  try {
    const res = await sendToContent(tabId, {
      type: "PROBE_POINTS",
      points: candidates.map((c) => ({ index: c.index, role: c.role, ...c.point })),
    });
    if (res.type !== "PROBE_RESULT") throw new Error(res.type === "ERROR" ? res.message : `unexpected ${res.type}`);
    probes = res.probes;
  } catch (err) {
    console.warn(LOG, "could not check vision-only boxes, continuing without them", err);
    return [];
  }
  const added: UIElement[] = [];
  for (const p of probes) {
    const v = visual[p.index];
    if (!p.keep || !p.id || !v) continue;
    v.addedAs = p.id;
    // Drawn controls carry no text in the page code: read it from the pixels instead.
    const read = !p.label && p.surface !== "widget" ? await readControlLabel(raw, v.bbox, snapshot.viewport.devicePixelRatio, ocr) : "";
    added.push({
      id: p.id,
      role: p.role ?? v.role,
      label: p.label || read,
      bbox: v.bbox,
      attributes: {
        source: "vision",
        ...(p.surface ? { surface: p.surface } : {}),
        ...(p.selected ? { checked: "yes" } : {}),
        ...(read ? { labelFrom: "ocr" } : {}),
      },
      isVisible: true,
      isInteractive: true,
    });
  }
  // Reading order (rows top to bottom, then left to right), like the DOM's own elements: a small
  // model works through a list in order, so "day, time, call type, Confirm" must read that way.
  const row = (e: UIElement) => Math.round((e.bbox.y + e.bbox.height / 2) / 24);
  added.sort((a, b) => row(a) - row(b) || a.bbox.x - b.bbox.x);
  console.info(LOG, `vision-only: ${added.length} of ${candidates.length} unlisted box(es) added`, probes.filter((p) => !p.keep).map((p) => p.reason));
  return added;
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

  // 1. DOM snapshot (+ boxes around PII found in page text and typed values), embedded frames
  //    included where the content script runs inside them
  const snapshot = await captureDom(tabId, includeText);
  const unreadFrames = await mergeFrames(tabId, snapshot, includeText);

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
  let visionOnly: UIElement[] = [];
  const ocr: OcrStats = { ms: 0, lines: 0 };
  if (rawImage && (await ensureUiDetector())) {
    try {
      const ui = await detectUiElements(rawImage);
      const cmp = compareWithDom(ui.detections, snapshot.elements, snapshot.viewport.devicePixelRatio, snapshot.viewport);
      summary.uiModelId = ui.modelId;
      summary.uiLatencyMs = ui.latencyMs;
      summary.visualElements = cmp.visual;
      vision = { ms: ui.latencyMs, detections: ui.detections.length, domCount: cmp.domCount, found: cmp.found, recall: cmp.recall, precision: cmp.precision };
      console.info(LOG, `vision: ${ui.detections.length} UI element(s) in ${ui.latencyMs} ms, found ${cmp.found}/${cmp.domCount} DOM elements, precision ${cmp.precision}`);
      if (CONFIG.uiDetector.actOnVisionOnly) {
        visionOnly = await visionOnlyElements(tabId, cmp.visual, snapshot, rawImage, ocr);
        if (visionOnly.length) vision.added = visionOnly.length;
      }
    } catch (err) {
      console.warn(LOG, "UI detection failed, continuing without it", err);
    }
  }

  // 3c. Embedded frames the content script cannot enter (a PDF viewer, a data: document): their
  //     text is read from pixels (OCR) and its personal data hidden. Not optional: a frame that
  //     cannot be read is hidden whole.
  const dpr = snapshot.viewport.devicePixelRatio;
  const frames = rawImage ? await readFrames(rawImage, unreadFrames, dpr, ocr) : { regions: [], text: [] };
  if (frames.text.length && snapshot.pageText !== undefined) {
    snapshot.pageText += frames.text.map((t) => `\n\n[Text inside an embedded frame, read from the screenshot]\n${t}`).join("");
  }
  if (ocr.lines || frames.regions.length) {
    summary.ocrModelId = CONFIG.ocr.modelId;
    summary.ocrLatencyMs = ocr.ms;
    summary.ocrLines = ocr.lines;
  }

  // 4. Redaction: faces (ml) + password/card fields (dom) + PII text (heuristic, ocr) are blacked
  //    out on a fresh copy; `rawImage`'s buffer is zeroed by sanitize(). Labels are scrubbed.
  const redacted = await sanitize({
    screenshot: rawImage,
    elements: [...snapshot.elements, ...visionOnly],
    perception,
    textRegions: [...(snapshot.textRegions ?? []), ...frames.regions, ...(CONFIG.hidePhotos ? (snapshot.imageRegions ?? []) : [])],
    devicePixelRatio: dpr,
  });
  const counts = countBy(redacted.redactions.map((r) => (r.category === "photo" ? "photo" : r.method)));
  console.info(
    LOG,
    `redaction: ${redacted.redactions.length} region(s) blacked out (faces ${counts.ml ?? 0}, photos ${counts.photo ?? 0}, fields ${counts.dom ?? 0}, text ${counts.heuristic ?? 0}, read from pixels ${counts.ocr ?? 0})`
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
      text: Math.max((counts.heuristic ?? 0) + (counts.ocr ?? 0), textHidden),
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
  gate: Gate = () => null,
  /** Fields the user chose to leave empty: shown to the reasoner as done so it moves on. */
  skipped: ReadonlySet<string> = new Set()
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
    for (const el of context.elements) {
      if (skipped.has(el.id)) el.attributes = { ...el.attributes, filled: "skipped" };
    }

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
      const label = target?.label || command.target;
      const resolved = hasPlaceholder(command.text) ? resolvePlaceholders(command.text, profile) : null;
      if (resolved?.missing.length) {
        missing = {
          status: "needs_user",
          message:
            `The form asks for "${label}", but "${resolved.missing.join('", "')}" is not saved${who} under My info. ` +
            `Everything that was saved has been filled in. Add the missing detail there, or fill that field yourself.`,
          ask: isFileField
            ? { question: `"${label}" needs a file, and none is saved${who} under My info. Add one under My info → Files and press Try again, or skip this field.`, target: command.target, label, file: true }
            : { question: `What should go in "${label}"? Nothing is saved${who} under My info for it.`, target: command.target, label },
        };
      } else if (isFileField !== Boolean(resolved?.file)) {
        // A file can only go into a file-upload field, and a file-upload field only takes a file.
        missing = {
          status: "needs_user",
          message: isFileField
            ? `"${label}" needs a file. Save one${who} under My info → Files, then run the task again.`
            : `"${resolved?.file?.label}" is a saved file, but "${label}" is not a file-upload field.`,
          ...(isFileField
            ? { ask: { question: `"${label}" needs a file, and none is saved${who} under My info. Add one under My info → Files and press Try again, or skip this field.`, target: command.target, label, file: true } }
            : {}),
        };
      } else if (resolved?.file) {
        const stored = resolved.file.fileId ? await getFile(resolved.file.fileId).catch(() => undefined) : undefined;
        if (!stored) {
          missing = {
            status: "needs_user",
            message: `The saved file "${resolved.file.label}" could not be read. Add it again under My info → Files.`,
            ask: { question: `The saved file "${resolved.file.label}" could not be read. Add it again under My info → Files and press Try again, or skip this field.`, target: command.target, label, file: true },
          };
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
  if (current?.status === "running" || current?.status === "confirm" || current?.status === "input") return current;
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

/** Repeats of the previous action that are skipped (and the model told) before the task stops. */
const MAX_REPEATS = 2;

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

/** Resolvers for questions waiting on the user's answer in the popup. Null means stop. */
const answers = new Map<number, (answer: InputAnswer | null) => void>();
const ANSWER_TIMEOUT_MS = 600_000;

function waitForAnswer(tabId: number): Promise<InputAnswer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), ANSWER_TIMEOUT_MS);
    const settle = (answer: InputAnswer | null) => {
      clearTimeout(timer);
      answers.delete(tabId);
      resolve(answer);
    };
    answers.set(tabId, settle);
  });
}

export function answerInput(tabId: number, answer: InputAnswer | null): boolean {
  const settle = answers.get(tabId);
  settle?.(answer);
  return settle !== undefined;
}

/** Saves an answer the user typed under My info, so the next form gets it without asking. */
async function saveAnswer(task: string, label: string, value: string): Promise<void> {
  const clean = label.replace(/\((optional|required)\)|\*/gi, "").replace(/\s+/g, " ").trim() || label;
  const key = toKey(clean);
  if (!key) return;
  const { people, activeId } = await loadPeople();
  if (people.length === 0) people.push({ id: newId(), name: "Me", fields: [] });
  const person = pickPerson(task, { people, activeId }) ?? people[0]!;
  const existing = person.fields.find((f) => f.key === key);
  if (existing) existing.value = value;
  else person.fields.push({ key, label: clean, value, kind: "text" });
  await savePeople(people, activeId || person.id);
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
  if (current?.status === "running" || current?.status === "confirm" || current?.status === "input") return current;

  stopRequested.delete(tabId);
  resetSession(tabId);
  await chrome.storage.local.set?.({ task });

  const state: TaskState = { tabId, task, mode: "act", status: "running", steps: [], maxSteps, startedAt: Date.now() };
  await publish(state);

  let previous: ActionCommand | undefined;
  let confirmed: "user" | "auto" | undefined;
  // The task as the reasoner sees it: the user's text plus any answers given mid-task.
  let reasoningTask = task;
  const skipped = new Set<string>();
  // Repeated actions forgiven so far, and the note telling the model about the last one.
  let repeats = 0;
  let repeatNote = "";
  const gate: Gate = async (command, context) => {
    confirmed = undefined;
    if (sameCommand(previous, command)) {
      const what = describeCommand(command, "target" in command ? context.elements.find((e) => e.id === command.target)?.label : undefined);
      // First repeats: not executed, and the model is told so it can move on. Only a model that
      // keeps repeating itself is stopped, so one slip does not end a demo.
      if (repeats < MAX_REPEATS) {
        repeats += 1;
        return { status: "stopped", message: `Skipped a repeat of: ${what}`, repeat: what };
      }
      return {
        status: "stopped",
        message: `The agent kept proposing the same action (${what}), so it was stopped to stay safe. Everything before it was done; check the page and run the task again if something is left.`,
      };
    }
    // Typing nothing into an empty field is how a small model "skips" it (an optional invoice
    // number). Doing it changes nothing, so it would propose it again and hit the repeat guard.
    if (command.action === "type" && !command.text.trim()) {
      const el = context.elements.find((e) => e.id === command.target);
      if (!el?.attributes?.filled || el.attributes.filled === "skipped") {
        return { status: "stopped", message: `Left "${el?.label || command.target}" empty.`, skipField: command.target };
      }
    }
    // Placeholders for saved details are allowed: runStep has already checked they exist.
    if (command.action === "type" && !hasPlaceholder(command.text) && !textComesFromTask(command.text, reasoningTask)) {
      const label = context.elements.find((e) => e.id === command.target)?.label || command.target;
      return {
        status: "needs_user",
        message: `The agent wanted to type "${command.text}", which is not in your task, so nothing was typed. Tell it exactly what to enter.`,
        ask: {
          question: `The agent wanted to type "${command.text}" into "${label}", but that is not in your task, so nothing was typed. What should go there?`,
          target: command.target,
          label,
          suggestion: command.text,
        },
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
    void showPopup(windowId);
    const allow = await waitForConfirmation(tabId);
    state.status = "running";
    delete state.pending;
    await publish(state);
    if (!allow) return { status: "stopped", message: `Not allowed: ${risk}. Nothing was done.` };
    confirmed = "user";
    return null;
  };

  /** Pauses the task on a question in the popup. Null when the user stopped or did not answer. */
  const ask = async (input: InputRequest): Promise<InputAnswer | null> => {
    state.status = "input";
    state.input = input;
    await publish(state);
    await setBadge(tabId, "?", "#9a6700");
    void showPopup(windowId);
    const answer = await waitForAnswer(tabId);
    state.status = "running";
    delete state.input;
    await publish(state);
    return answer;
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
      const result = await runStep(tabId, windowId, reasoningTask + repeatNote, gate, skipped);
      repeatNote = "";
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
      if (result.veto?.repeat) {
        repeatNote =
          `\nNote: "${result.veto.repeat}" was already done in the previous step, so it was not repeated. ` +
          `Do the next part of the task, or reply "done" if the page shows it is finished.`;
        log.summary = result.veto.message;
        log.ok = true;
        await publish(state);
        await sleep(CONFIG.stepDelayMs);
        continue;
      }
      if (result.veto?.skipField) {
        // One repeat of the same skip is let through; a second one hits the repeat guard.
        previous = skipped.has(result.veto.skipField) ? result.command : undefined;
        skipped.add(result.veto.skipField);
        log.summary = result.veto.message;
        log.ok = true;
        await publish(state);
        await sleep(CONFIG.stepDelayMs);
        continue;
      }
      // Something only the user can supply: ask in the popup and carry on, instead of ending the
      // task. Automated runs (autoConfirm) have nobody to ask, so they stop as before.
      const question: InputRequest | undefined =
        result.veto?.ask ?? (action === "ask_user" && result.command.action === "ask_user" ? { question: result.command.question } : undefined);
      if (question && !opts.autoConfirm) {
        const answer = await ask(question);
        if (!answer) {
          state.status = "stopped";
          state.message = stopRequested.has(tabId) ? "Stopped by you." : "No answer was given, so the task was stopped.";
          break;
        }
        if (question.target === undefined) {
          // A plain question: the answer becomes part of the task, so the agent may type it.
          if (answer.kind === "fill" && answer.text.trim()) {
            reasoningTask += `\nAnswer to "${question.question}": ${answer.text.trim()}`;
            log.summary += ` (you answered)`;
            log.ok = true;
          }
        } else if (answer.kind === "skip") {
          skipped.add(question.target);
          log.summary = `Left "${question.label}" empty (skipped by you)`;
          log.ok = true;
        } else if (answer.kind === "fill" && answer.text.trim()) {
          const text = answer.text.trim();
          const typed = await executeOnPage(tabId, { action: "type", target: question.target, text } as ActionCommand, true);
          if (answer.save && question.label) await saveAnswer(task, question.label, text).catch((err: unknown) => console.warn(LOG, "could not save answer", err));
          log.summary = `Typed your answer into "${question.label}"${answer.save ? " (saved to My info)" : ""}`;
          log.ok = typed.ok;
          log.message = typed.message;
        }
        // "retry" (e.g. after adding a file under My info) just runs the next step again.
        await publish(state);
        previous = undefined;
        await sleep(CONFIG.stepDelayMs);
        continue;
      }
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

/** Open the popup so a pending Allow / Don't allow is seen without hunting for the toolbar icon. */
async function showPopup(windowId: number | undefined): Promise<void> {
  try {
    await chrome.action.openPopup(windowId !== undefined ? { windowId } : undefined);
  } catch {
    // Already open, window not focused, or unsupported (Firefox): the "?" badge still shows.
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
  frameNumbers.delete(tabId);
  tasks.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return false;
  const msg = message as PopupRequest;

  switch (msg.type) {
    case "FRAME_HELLO":
      if (sender.tab?.id !== undefined && sender.frameId !== undefined && sender.frameId !== 0) frameHello(msg.nonce, sender.tab.id, sender.frameId);
      return false;
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
    case "ANSWER":
      sendResponse({ ok: answerInput(msg.tabId, msg.answer) });
      return false;
    case "STOP_TASK":
      stopRequested.add(msg.tabId);
      confirmAction(msg.tabId, false); // a pending "Allow?" counts as refused
      answerInput(msg.tabId, null); // and a pending question as unanswered
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
