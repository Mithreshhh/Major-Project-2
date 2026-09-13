/**
 * Message protocol between the background worker and the content script.
 * (Internal to the extension; the extension <-> server contract lives in @odpa/shared.)
 */
import type { ActionCommand, PageMeta, UIElement, Viewport } from "@odpa/shared";

export interface DomSnapshot {
  page: PageMeta;
  viewport: Viewport;
  /** Raw (not yet redacted) element summaries. Never includes form *values*. */
  elements: UIElement[];
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

/** Result of one full agent step, returned by the background worker for logging/UI. */
export interface StepResult {
  command: ActionCommand;
  execution: ExecutionResult;
  stepIndex: number;
  sessionId: string;
}
