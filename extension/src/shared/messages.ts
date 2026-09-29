/**
 * Message protocol inside the extension: background <-> content script, background <-> popup.
 * (The extension <-> server contract lives in @odpa/shared.)
 */
import type { ActionCommand, PageMeta, RedactedRegion, UIElement, Viewport } from "@odpa/shared";

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
}

export interface ExecutionResult {
  ok: boolean;
  message?: string;
}

export type ContentRequest =
  | { type: "PING" }
  | { type: "CAPTURE_DOM" }
  | { type: "EXECUTE_ACTION"; command: ActionCommand };

export type ContentResponse =
  | { type: "PONG" }
  | { type: "DOM_SNAPSHOT"; snapshot: DomSnapshot }
  | { type: "EXECUTION_RESULT"; result: ExecutionResult }
  | { type: "ERROR"; message: string };

export interface RedactionCounts {
  faces: number;
  fields: number;
  text: number;
}

/** Result of one agent step. */
export interface StepResult {
  command: ActionCommand;
  execution: ExecutionResult;
  /** True when the command was returned by the server but deliberately not executed. */
  skipped: boolean;
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

export type TaskStatus = "running" | "done" | "needs_user" | "stopped" | "failed" | "max_steps";

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
}

export interface TaskState {
  tabId: number;
  task: string;
  status: TaskStatus;
  steps: StepLog[];
  maxSteps: number;
  /** Final explanation: the model's summary, its question, or why the task stopped. */
  message?: string;
  startedAt: number;
  finishedAt?: number;
}

export type PopupRequest =
  | { type: "RUN_TASK"; tabId: number; windowId?: number; task: string; maxSteps?: number }
  | { type: "STOP_TASK"; tabId: number }
  | { type: "GET_TASK_STATE"; tabId: number }
  | { type: "RUN_STEP"; tabId: number; windowId?: number };

export type BackgroundBroadcast = { type: "TASK_UPDATE"; state: TaskState };

export function describeCommand(c: ActionCommand): string {
  switch (c.action) {
    case "click":
      return `Click ${c.target}`;
    case "type":
      return `Type "${c.text}" into ${c.target}${c.submit ? " and submit" : ""}`;
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
