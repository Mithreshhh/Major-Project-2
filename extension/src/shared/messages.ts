/**
 * Message protocol inside the extension: background <-> content script, background <-> popup.
 * (The extension <-> server contract lives in @odpa/shared.)
 */
import type { ActionCommand, PageMeta, RedactedRegion, SanitizedContext, UIElement, Viewport } from "@odpa/shared";

export interface DomSnapshot {
  page: PageMeta;
  viewport: Viewport;
  /** Raw (not yet redacted) element summaries. Never includes form *values*. */
  elements: UIElement[];
  /**
   * Boxes (CSS px) around PII found in visible page text and typed input values. Only the boxes
   * cross the message boundary; the matched text stays in the page.
   */
  textRegions: RedactedRegion[];
  /** Boxes (CSS px) of every photo, video and canvas in view (category "photo"). */
  imageRegions?: RedactedRegion[];
  /** Visible page text (document.body.innerText), only when asked for. Redacted in the background. */
  pageText?: string;
}

export interface ExecutionResult {
  ok: boolean;
  message?: string;
}

export type ContentRequest =
  | { type: "PING" }
  | { type: "CAPTURE_DOM"; includeText?: boolean }
  /** `sensitive`: the typed text is a saved detail, so the field is masked in later screenshots. */
  | { type: "EXECUTE_ACTION"; command: ActionCommand; sensitive?: boolean }
  /** Attach a saved file ("My info") to the file-upload field `target`. */
  | { type: "UPLOAD_FILE"; target: string; file: { name: string; type: string; dataBase64: string } };

export type ContentResponse =
  | { type: "PONG" }
  | { type: "DOM_SNAPSHOT"; snapshot: DomSnapshot }
  | { type: "EXECUTION_RESULT"; result: ExecutionResult }
  | { type: "ERROR"; message: string };

export interface RedactionCounts {
  faces: number;
  /** Photos, videos and canvases hidden from the DOM (avatars, posts). */
  photos: number;
  fields: number;
  text: number;
}

/** Result of one agent step. */
export interface StepResult {
  command: ActionCommand;
  execution: ExecutionResult;
  /** True when the command was returned by the server but deliberately not executed. */
  skipped: boolean;
  /** Why it was not executed, and what the task should become. */
  veto?: Veto;
  /** Set when a risky action ran after confirmation. */
  confirmed?: "user" | "auto";
  /** Redacted label of the element the command targets, for display. */
  targetLabel?: string;
  /** Labels of the saved details ("My info") typed in this step. The values are not kept here. */
  savedDetails?: string[];
  /** Whose saved details were used ("Me", "Father"). */
  person?: string;
  /** True when a saved file was attached rather than text typed. */
  attached?: boolean;
  stepIndex: number;
  sessionId: string;
  redactions: RedactionCounts;
  perceptionMs: number;
  /** Vision-based UI detection, scored against the DOM. Absent when the UI model did not run. */
  vision?: VisionStats;
}

export interface VisionStats {
  ms: number;
  detections: number;
  /** DOM buttons/inputs/links in view, and how many of them vision found. */
  domCount: number;
  found: number;
  recall: number;
  precision: number;
}

// ---------------------------------------------------------------------------
// Popup <-> background
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "running"
  | "confirm" // waiting for the user to allow a risky action
  | "done"
  | "answered" // ask mode: the answer is in `message`
  | "needs_user"
  | "stopped"
  | "failed"
  | "max_steps";

/** A reason not to execute the model's command. */
export interface Veto {
  status: TaskStatus;
  message: string;
}

export interface StepLog {
  index: number;
  /** Human-readable, e.g. `type "john@example.com" into el_1`. */
  summary: string;
  command: ActionCommand;
  ok: boolean;
  message?: string;
  redactions: RedactionCounts;
  ms: number;
  vision?: VisionStats;
  confirmed?: "user" | "auto";
}

export interface TaskState {
  tabId: number;
  task: string;
  /** "act" works on the page; "ask" only answers a question about it and never acts. */
  mode: "act" | "ask";
  status: TaskStatus;
  /** Ask mode: what was hidden before the page text and screenshot left the device. */
  hidden?: RedactionCounts;
  /** Risky action waiting for the user's decision (status "confirm"). */
  pending?: string;
  /** Whose saved details ("My info") this task is using, when it uses any. */
  person?: string;
  steps: StepLog[];
  maxSteps: number;
  /** Final explanation: the model's summary, its question, or why the task stopped. */
  message?: string;
  startedAt: number;
  finishedAt?: number;
}

export type PopupRequest =
  | { type: "RUN_TASK"; tabId: number; windowId?: number; task: string; maxSteps?: number }
  | { type: "ASK"; tabId: number; windowId?: number; question: string }
  | { type: "CONFIRM"; tabId: number; allow: boolean }
  | { type: "STOP_TASK"; tabId: number }
  | { type: "GET_TASK_STATE"; tabId: number }
  | { type: "RUN_STEP"; tabId: number; windowId?: number };

export type BackgroundBroadcast = { type: "TASK_UPDATE"; state: TaskState };

/** Human-readable command. `targetLabel` (already redacted) replaces the element id when known. */
export function describeCommand(c: ActionCommand, targetLabel?: string, savedDetails?: string[], isFile = false): string {
  const target = (id: string) => (targetLabel ? `"${targetLabel.length > 40 ? `${targetLabel.slice(0, 39)}…` : targetLabel}"` : id);
  switch (c.action) {
    case "click":
      return `Click ${target(c.target)}`;
    case "type":
      if (savedDetails?.length && isFile) return `Attach the saved ${savedDetails.join(", ")} to ${target(c.target)}`;
      if (savedDetails?.length) return `Type the saved ${savedDetails.join(", ")} into ${target(c.target)}${c.submit ? " and submit" : ""}`;
      return `Type "${c.text}" into ${target(c.target)}${c.submit ? " and submit" : ""}`;
    case "scroll":
      return `Scroll ${c.direction}`;
    case "navigate":
      return `Go to ${c.url}`;
    case "wait":
      return `Wait ${c.ms} ms`;
    case "done":
      return `Done: ${c.summary}`;
    case "ask_user":
      return `Question: ${c.question}`;
    case "noop":
      return `Nothing to do: ${c.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Safety rules (shared by the background and the popup)
// ---------------------------------------------------------------------------

const POLITE = /^(hey|hi|hello|ok(ay)?|please|pls|kindly|can you|could you|would you|will you|can u|i want you to|i need you to)[\s,]+/i;
const ACTION_START =
  /^(fill|type|enter|input|click|press|tap|submit|log ?in|sign ?(in|up|on)|register|search( for)?|open|go to|navigate|visit|select|choose|tick|check the|uncheck|book|buy|order|pay|send|add|remove|delete|scroll|download|upload|subscribe|clear|reset|save|create|write|reply|post|complete|accept|agree)\b/i;
const QUESTION =
  /\?\s*$|^(what|which|who|whom|whose|when|where|why|how|is|are|was|were|does|do|did|can|could|should|will|would|has|have|tell me|explain|describe|summari[sz]e|analy[sz]e|review|list|check (if|whether)|find out|give me|show me)\b|\b(analy[sz]e|analysis|summary|summari[sz]e|explain|describe|overview)\b/i;

/**
 * True when the text asks for information rather than for work on the page, e.g. "analyze this
 * login page" or "what does this form ask for?". Such tasks run in ask mode, which cannot act.
 * Polite prefixes are ignored, so "can you fill the form ..." is still a task.
 */
export function looksLikeQuestion(text: string): boolean {
  let t = text.trim();
  for (let i = 0; i < 3 && POLITE.test(t); i++) t = t.replace(POLITE, "");
  if (ACTION_START.test(t)) return false;
  return QUESTION.test(t) || QUESTION.test(text.trim());
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`.,!?;:]+$/g, "");

/** The agent may only type what the user wrote in the task: never invented names or passwords. */
export function textComesFromTask(text: string, task: string): boolean {
  const t = norm(text);
  return t.length === 0 || norm(task).includes(t);
}

const RISKY =
  /\b(log ?in|sign ?(in|up|on)|register|submit|send|pay|payment|buy|purchase|order|checkout|check ?out|delete|remove|confirm|transfer|book|subscribe|publish|post|place)\b/i;

/**
 * Describes the command when it has consequences outside the page (logging in, submitting,
 * paying, deleting, sending), so the user can allow or refuse it. Null for harmless actions.
 */
export function riskyAction(command: ActionCommand, context: Pick<SanitizedContext, "elements">): string | null {
  if (command.action === "click") {
    const el = context.elements.find((e) => e.id === command.target);
    const words = [el?.label, el?.attributes?.["aria-label"], el?.attributes?.title].filter(Boolean).join(" ");
    if (RISKY.test(words) || el?.attributes?.type === "submit") return `Click "${el?.label || command.target}"`;
    return null;
  }
  if (command.action === "type" && command.submit) return `Type "${command.text}" and submit the form`;
  return null;
}
