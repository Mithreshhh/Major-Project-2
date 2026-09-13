/**
 * Extension <-> Server data contract.
 *
 * Direction of data flow:
 *
 *   client (extension)  --- SanitizedContext --->  server (VLM reasoning)
 *   client (extension)  <--- ActionCommand -------  server
 *
 * INVARIANT: everything inside a SanitizedContext has already passed through the on-device
 * redaction pipeline (see /perception/src/redaction.ts). The server must be able to assume it
 * never receives raw PII. The client is the trust boundary, not the server.
 *
 * The JSON Schemas in ../schema/ are the language-neutral form of these types.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Axis-aligned rectangle in CSS pixels, relative to the top-left of the *viewport*
 * (not the document). Multiply by `Viewport.devicePixelRatio` to map onto screenshot pixels.
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Page / viewport metadata
// ---------------------------------------------------------------------------

export interface Viewport {
  /** Viewport width in CSS pixels (window.innerWidth). */
  width: number;
  /** Viewport height in CSS pixels (window.innerHeight). */
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface PageMeta {
  /**
   * Page URL. NOTE: URLs can carry sensitive query params/tokens; the redaction layer is
   * responsible for stripping them before this object is populated.
   */
  url: string;
  title: string;
  /** ISO-8601 timestamp of when the capture was taken (client clock). */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// DOM summary
// ---------------------------------------------------------------------------

/** Coarse semantic role of a UI element (a simplification of ARIA roles). */
export type ElementRole =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "select"
  | "option"
  | "image"
  | "heading"
  | "text"
  | "other";

/**
 * A compact, sanitized description of a single UI element. The server references elements
 * by `id` in ActionCommand.target, so ids must be stable for the lifetime of one step.
 */
export interface UIElement {
  /** Per-snapshot identifier, e.g. "el_12". Regenerated on every capture. */
  id: string;
  role: ElementRole;
  /** Accessible name / visible text. Already redacted where necessary. */
  label: string;
  bbox: BoundingBox;
  /** Whitelisted, non-sensitive attributes only (e.g. type, placeholder, aria-label). */
  attributes?: Record<string, string>;
  isVisible: boolean;
  isInteractive: boolean;
  /** True when `label` or an attribute value was masked by the redaction layer. */
  redacted?: boolean;
}

// ---------------------------------------------------------------------------
// Redaction bookkeeping
// ---------------------------------------------------------------------------

export type SensitiveCategory =
  | "pii_text"
  | "credential"
  | "payment_card"
  | "face"
  | "address"
  | "email"
  | "phone"
  | "other";

export type RedactionMethod = "ml" | "heuristic" | "dom";

/**
 * A region of the screenshot (and/or DOM) that was masked before leaving the device.
 * Sent to the server so the reasoner knows *that* something was hidden, but not *what*.
 */
export interface RedactedRegion {
  bbox: BoundingBox;
  category: SensitiveCategory;
  /** 0..1 confidence of the detector that produced this region. */
  confidence: number;
  /** Which detector produced the region. */
  method: RedactionMethod;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export type ScreenshotMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface SanitizedScreenshot {
  mimeType: ScreenshotMimeType;
  /** Base64-encoded image bytes (no data: URL prefix). Already redacted. */
  dataBase64: string;
  /** Pixel dimensions of the encoded image. */
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Perception summary
// ---------------------------------------------------------------------------

/** Small summary of what the on-device model produced, for observability/debugging. */
export interface PerceptionSummary {
  /** Identifier of the on-device model that ran, e.g. "vit-tiny-ui-v0" or "placeholder". */
  modelId: string;
  latencyMs: number;
  /** Optional compact embedding of the screen (may be omitted to save bandwidth). */
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Request: SanitizedContext
// ---------------------------------------------------------------------------

/**
 * The payload POSTed to /process. This is the *only* thing that ever leaves the device.
 */
export interface SanitizedContext {
  protocolVersion: string;
  /** Stable id for one user task across many steps. */
  sessionId: string;
  /** 0-based index of this step within the session. */
  stepIndex: number;
  /** The user's natural-language goal, e.g. "Submit the contact form". */
  task: string;
  page: PageMeta;
  viewport: Viewport;
  elements: UIElement[];
  /** Redacted screenshot, or null when the client chose not to send pixels at all. */
  screenshot: SanitizedScreenshot | null;
  redactions: RedactedRegion[];
  /** Commands the client has already executed in this session (most recent last). */
  history: ActionCommand[];
  perception: PerceptionSummary;
}

// ---------------------------------------------------------------------------
// Response: ActionCommand
// ---------------------------------------------------------------------------

/** Metadata the server may attach to any command. */
export interface ActionMeta {
  /** Free-text explanation from the reasoner (for logs / UI, never executed). */
  reasoning?: string;
  /** 0..1 confidence the reasoner has in this command. */
  confidence?: number;
}

export interface ClickAction extends ActionMeta {
  action: "click";
  /** `UIElement.id` from the request's `elements` array. */
  target: string;
}

export interface TypeAction extends ActionMeta {
  action: "type";
  target: string;
  text: string;
  /** Press Enter after typing. */
  submit?: boolean;
}

export interface ScrollAction extends ActionMeta {
  action: "scroll";
  direction: "up" | "down";
  /** Defaults to one viewport height when omitted. */
  amountPx?: number;
}

export interface NavigateAction extends ActionMeta {
  action: "navigate";
  url: string;
}

export interface WaitAction extends ActionMeta {
  action: "wait";
  ms: number;
}

/** The task is complete; no further steps should be requested. */
export interface DoneAction extends ActionMeta {
  action: "done";
  summary: string;
}

/** The reasoner needs input from the human before it can continue. */
export interface AskUserAction extends ActionMeta {
  action: "ask_user";
  question: string;
}

/** Nothing to do this step (e.g. page still loading). */
export interface NoopAction extends ActionMeta {
  action: "noop";
  reason: string;
}

export type ActionCommand =
  | ClickAction
  | TypeAction
  | ScrollAction
  | NavigateAction
  | WaitAction
  | DoneAction
  | AskUserAction
  | NoopAction;

export type ActionType = ActionCommand["action"];

// ---------------------------------------------------------------------------
// Misc server responses
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  protocolVersion: string;
  /** Identifier of the server-side reasoner, e.g. "mock" until a real VLM is wired in. */
  reasoner: string;
}

/** Shape of every error response from the server (FastAPI default). */
export interface ErrorResponse {
  detail: string;
}
