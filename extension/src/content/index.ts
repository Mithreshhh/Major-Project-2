/**
 * Content script: runs inside every http(s) page.
 *
 * Responsibilities
 *   - CAPTURE_DOM      build a compact, PII-conscious summary of the visible UI
 *   - EXECUTE_ACTION   carry out an ActionCommand the server returned
 *   - PROBE_POINTS     check what is under boxes only the vision model found; keep clickable ones
 *
 * It never captures pixels itself (only the background can call captureVisibleTab) and it
 * never forwards form *values*. Labels are still raw here; redaction happens in the background
 * worker via @odpa/perception before anything leaves the device.
 */
import { findPii } from "@odpa/perception/pii";
import type { ActionCommand, BoundingBox, ElementRole, RedactedRegion, UIElement } from "@odpa/shared";

import type { ContentRequest, ContentResponse, DomSnapshot, ExecutionResult } from "../shared/messages";

const LOG = "[odpa:content]";
const MAX_ELEMENTS = 200;
const MAX_TEXT_NODES = 5000;

/** Attributes that are safe to forward. Everything else (value, href, data-*) is dropped. */
const ATTRIBUTE_WHITELIST = ["type", "placeholder", "aria-label", "role", "title", "name", "alt", "autocomplete"];

/** `UIElement.id` -> live DOM node, for the most recent snapshot. */
let registry = new Map<string, Element>();
/** Interactive elements in the most recent snapshot: what a vision box must not duplicate. */
let listedControls = new Set<Element>();

/**
 * Fields the agent filled with one of the user's saved details ("My info"). Their values are
 * personal even when no pattern matches (a name, a college), so they are always masked.
 */
const filledFromProfile = new WeakSet<Element>();

// ---------------------------------------------------------------------------
// DOM capture
// ---------------------------------------------------------------------------

const CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=checkbox]",
  "[role=radio]",
  "[contenteditable=true]",
  "h1, h2, h3",
  "img[alt]",
  // Live status text ("Form submitted", error messages) so the reasoner can tell it is done.
  "[role=status]",
  "[role=alert]",
  "[aria-live]",
].join(",");

function roleOf(el: Element): ElementRole {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute("role");
  if (aria && ["button", "link", "textbox", "checkbox", "radio", "option"].includes(aria)) {
    return aria as ElementRole;
  }
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "select";
  if (tag === "option") return "option";
  if (tag === "textarea" || el.getAttribute("contenteditable") === "true") return "textbox";
  if (tag === "img") return "image";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (aria === "status" || aria === "alert" || el.hasAttribute("aria-live")) return "text";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    return "textbox";
  }
  return "other";
}

function labelOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const explicit = el.labels?.[0]?.textContent?.trim();
    if (explicit) return explicit;
    // Buttons carry their caption in `value`; other inputs' values are user data and are skipped.
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) {
      return el.value;
    }
    return el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "";
  }

  if (el instanceof HTMLImageElement) return el.alt;

  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function bboxOf(el: Element): BoundingBox {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function isVisible(el: Element, bbox: BoundingBox): boolean {
  if (bbox.width <= 0 || bbox.height <= 0) return false;
  if (bbox.x + bbox.width < 0 || bbox.y + bbox.height < 0) return false;
  if (bbox.x > window.innerWidth || bbox.y > window.innerHeight) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

const FORM_ROLES = new Set<ElementRole>(["textbox", "checkbox", "radio", "select", "button"]);

/** Has a box and is not hidden by CSS; may be outside the viewport. */
function isRendered(el: Element, bbox: BoundingBox): boolean {
  if (bbox.width <= 0 || bbox.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/**
 * Ids that stay the same for an element across snapshots. Numbering by position would shift
 * every id whenever the page scrolls, and the reasoner's history ("typed into el_8") would then
 * point at the wrong field.
 */
let stableIds = new WeakMap<Element, string>();
let nextId = 0;
/** "el_" in the top page; "el_f2_" in the second embedded frame, so ids are unique per tab. */
let idPrefix = "el_";

function setIdPrefix(prefix: string): void {
  if (prefix === idPrefix) return;
  idPrefix = prefix;
  stableIds = new WeakMap();
  nextId = 0;
}

function stableId(el: Element): string {
  let id = stableIds.get(el);
  if (!id) {
    id = `${idPrefix}${nextId++}`;
    stableIds.set(el, id);
  }
  return id;
}

/**
 * Whether a field already holds something, as "filled" / "checked". Only the fact, never the
 * value: it lets the reasoner move on to the next empty field instead of retyping.
 */
function stateAttributes(el: Element): Record<string, string> {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? { checked: "yes" } : {};
    if (el.type === "file") return el.files?.length ? { filled: "yes" } : {};
    if (["button", "submit", "reset", "image", "hidden"].includes(el.type)) return {};
    return el.value ? { filled: "yes" } : {};
  }
  if (el instanceof HTMLTextAreaElement) return el.value ? { filled: "yes" } : {};
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 ? { filled: "yes" } : {};
  return {};
}

function isInteractive(el: Element, role: ElementRole): boolean {
  if (role === "heading" || role === "image" || role === "text") return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return true;
}

function safeAttributes(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of ATTRIBUTE_WHITELIST) {
    const v = el.getAttribute(name);
    if (v) out[name] = v.slice(0, 100);
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// On-page PII scan. Runs entirely in the page; only bounding boxes leave this function.
// ---------------------------------------------------------------------------

function inViewport(b: BoundingBox): boolean {
  return b.width > 0 && b.height > 0 && b.x + b.width > 0 && b.y + b.height > 0 && b.x < window.innerWidth && b.y < window.innerHeight;
}

/** Visible text nodes containing an email, phone, card or ID number -> one box per rendered line. */
function scanTextForPii(): RedactedRegion[] {
  const regions: RedactedRegion[] = [];
  if (!document.body) return regions;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue || node.nodeValue.trim().length < 6) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, textarea, [contenteditable=true]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let visited = 0;
  for (let node = walker.nextNode(); node && visited < MAX_TEXT_NODES; node = walker.nextNode(), visited++) {
    const text = node.nodeValue ?? "";
    const matches = findPii(text);
    if (matches.length === 0) continue;
    const style = getComputedStyle(node.parentElement!);
    if (style.visibility === "hidden" || style.display === "none") continue;
    for (const m of matches) {
      const range = document.createRange();
      range.setStart(node, m.start);
      range.setEnd(node, m.end);
      for (const r of range.getClientRects()) {
        const bbox = { x: r.left, y: r.top, width: r.width, height: r.height };
        if (inViewport(bbox)) regions.push({ bbox, category: m.category, confidence: 0.99, method: "heuristic" });
      }
      range.detach();
    }
  }
  return regions;
}

/**
 * Input fields whose current *value* is sensitive: any value containing PII, and any non-empty
 * email/tel field. The value is inspected here and never forwarded; the whole field is masked.
 */
function scanInputValuesForPii(): RedactedRegion[] {
  const regions: RedactedRegion[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    // A file field the agent attached a saved file to shows the file name: mask it.
    if (el instanceof HTMLInputElement && el.type === "file") {
      const box = bboxOf(el);
      if (filledFromProfile.has(el) && inViewport(box)) regions.push({ bbox: box, category: "pii_text", confidence: 0.99, method: "heuristic" });
      continue;
    }
    if (el instanceof HTMLInputElement && ["password", "hidden", "checkbox", "radio", "submit", "button", "reset", "image"].includes(el.type)) {
      continue; // password fields are handled by the DOM rules; the rest carry no typed text
    }
    const value = el.value;
    if (!value) continue;
    const matches = findPii(value);
    const typed = el instanceof HTMLInputElement && (el.type === "email" || el.type === "tel");
    if (matches.length === 0 && !typed && !filledFromProfile.has(el)) continue;
    const bbox = bboxOf(el);
    if (!inViewport(bbox)) continue;
    const type = (el as HTMLInputElement).type;
    const category = matches[0]?.category ?? (type === "tel" ? "phone" : type === "email" ? "email" : "pii_text");
    regions.push({ bbox, category, confidence: 0.99, method: "heuristic" });
  }
  return regions;
}

/** Smaller than this (CSS px, either side) is an icon, not a photo. */
const MIN_PHOTO_PX = 20;
const MAX_BACKGROUND_SCAN = 4000;

/**
 * Every photo-like thing in the viewport: <img>, <video>, <canvas>, <picture>, [role=img] with a
 * raster source, and elements with a CSS background image. Catches avatars and posts of any
 * size, which the face model cannot see when they are tiny (a 32 px avatar is ~13 px at the
 * model's input). Icons (small, or SVG) are skipped so the page stays readable.
 */
function scanImages(): RedactedRegion[] {
  const regions: RedactedRegion[] = [];
  if (!document.body) return regions;
  const seen = new Set<Element>();

  const consider = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < MIN_PHOTO_PX || r.height < MIN_PHOTO_PX) return;
    const bbox = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (!inViewport(bbox)) return;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return;
    regions.push({ bbox, category: "photo", confidence: 1, method: "dom" });
  };

  for (const el of document.querySelectorAll("img, video, canvas, picture, [role=img]")) {
    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src;
      if (/\.svg(\?|#|$)/i.test(src) || src.startsWith("data:image/svg")) continue; // vector icon
    }
    if (el.tagName === "PICTURE" && el.querySelector("img")) continue; // the <img> inside is enough
    if (el.getAttribute("role") === "img" && el.querySelector("svg") && !el.querySelector("img")) continue;
    consider(el);
  }

  // CSS background photos (cover images, avatars drawn as divs). Rect first: it is cheaper than
  // computed style and rules out most elements.
  const all = document.body.getElementsByTagName("*");
  for (let i = 0; i < all.length && i < MAX_BACKGROUND_SCAN; i++) {
    const el = all[i]!;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_PHOTO_PX || r.height < MIN_PHOTO_PX || r.bottom < 0 || r.top > window.innerHeight) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none" && /url\(/i.test(bg) && !/\.svg/i.test(bg) && !/data:image\/svg/i.test(bg)) consider(el);
  }
  return regions;
}

const PAGE_TEXT_MAX = 15_000;

/**
 * Rendered, visible text of the page (hidden elements excluded by innerText; form values are
 * never part of innerText, so typed passwords cannot leak). PII is replaced in the background.
 */
export function collectPageText(): string {
  const raw = document.body?.innerText ?? "";
  const text = raw
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > PAGE_TEXT_MAX ? text.slice(0, PAGE_TEXT_MAX) : text;
}

export function captureDom(includeText = false, frame?: number): DomSnapshot {
  setIdPrefix(frame === undefined ? "el_" : `el_f${frame}_`);
  registry = new Map();
  listedControls = new Set();
  pointTargets = new Map();
  const elements: UIElement[] = [];

  for (const el of document.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (elements.length >= MAX_ELEMENTS) break;

    const bbox = bboxOf(el);
    const role = roleOf(el);
    const visible = isVisible(el, bbox);
    // Links, headings and images matter only when on screen. Form controls and buttons are kept
    // even below the fold, so a long form can be filled without the reasoner having to scroll
    // (typing or clicking scrolls the element into view).
    if (!visible && !(FORM_ROLES.has(role) && isRendered(el, bbox))) continue;
    if (role === "text" && !(el.textContent ?? "").trim()) continue; // empty status region

    const id = stableId(el);
    registry.set(id, el);
    if (isInteractive(el, role)) listedControls.add(el);

    const element: UIElement = {
      id,
      role,
      label: labelOf(el),
      bbox,
      isVisible: visible,
      isInteractive: isInteractive(el, role),
    };
    const attributes = { ...safeAttributes(el), ...stateAttributes(el) };
    if (Object.keys(attributes).length) element.attributes = attributes;
    elements.push(element);
  }

  return {
    page: {
      // TODO(redaction): strip query strings / fragments that may carry tokens.
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    },
    elements,
    textRegions: [...scanTextForPii(), ...scanInputValuesForPii()],
    imageRegions: scanImages(),
    ...(includeText ? { pageText: collectPageText() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Vision-only elements: controls the UI detector sees that the DOM scan does not list
// ---------------------------------------------------------------------------

/** Where a vision-only element is acted on: a point in the viewport and what was under it. */
interface PointTarget {
  x: number;
  y: number;
  node: Element;
}

/** `vis_N` id -> point target, for the most recent probe. */
let pointTargets = new Map<string, PointTarget>();

/** Surfaces the DOM cannot see into: anything drawn there is only visible in pixels. */
const OPAQUE: Record<string, NonNullable<PointProbe["surface"]>> = {
  CANVAS: "canvas",
  IFRAME: "frame",
  EMBED: "frame",
  OBJECT: "frame",
  IMG: "image",
  VIDEO: "image",
};

/** How far up from the element under the point a scripted control is looked for. */
const MAX_WIDGET_DEPTH = 6;

/** Signs that an element reacts to clicks although it is no button, link or field. */
function looksClickable(el: Element): boolean {
  if (el instanceof HTMLElement) {
    if (el.onclick || el.hasAttribute("onclick") || el.isContentEditable) return true;
    if (el.hasAttribute("tabindex") && el.tabIndex >= 0) return true;
  }
  return getComputedStyle(el).cursor === "pointer";
}

/**
 * Stable ids for vision-only elements, like stableId for listed ones, so "clicked vis_1" in the
 * history still means the same control on the next step. A surface (a canvas) can hold several
 * controls, so there the id is per 16 px cell of the surface.
 */
const visionIds = new WeakMap<Element, Map<string, string>>();
let nextVisionId = 0;

function visionId(node: Element, cell: string): string {
  let ids = visionIds.get(node);
  if (!ids) visionIds.set(node, (ids = new Map()));
  let id = ids.get(cell);
  if (!id) ids.set(cell, (id = `vis_${nextVisionId++}`));
  return id;
}

function shortText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * For each vision box centre: is the thing under it already listed (drop), a scripted control
 * the DOM scan missed, e.g. a `<div onclick>` styled as a button (keep, label from its text), or
 * a surface the DOM cannot describe, such as a canvas (keep, label only from its attributes)?
 * Anything else is a vision false positive, such as a heading or plain text (drop).
 */
export function probePoints(points: ProbePoint[]): PointProbe[] {
  const viewportArea = window.innerWidth * window.innerHeight;
  const claimed = new Set<Element>();
  return points.map(({ index, role, x, y }): PointProbe => {
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === document.documentElement || hit === document.body) return { index, keep: false, reason: "nothing there" };
    for (let el: Element | null = hit; el; el = el.parentElement) {
      if (listedControls.has(el)) return { index, keep: false, reason: "already listed" };
    }

    const surface = OPAQUE[hit.tagName];
    if (surface === "frame") return { index, keep: false, reason: "inside an embedded frame: a click cannot reach it" };
    let node: Element;
    let label: string;
    if (surface) {
      node = hit;
      label = shortText(hit.getAttribute("aria-label") || hit.getAttribute("title") || hit.getAttribute("alt"));
    } else {
      if (!looksClickable(hit)) return { index, keep: false, reason: "not clickable" };
      // The outermost element of the clickable run is the control; its children inherit the cursor.
      node = hit;
      for (let depth = 0, up = hit.parentElement; depth < MAX_WIDGET_DEPTH && up && up !== document.body; depth++, up = up.parentElement) {
        if (!looksClickable(up)) break;
        node = up;
      }
      const r = node.getBoundingClientRect();
      if (r.width * r.height > viewportArea / 4) return { index, keep: false, reason: "too large to be one control" };
      if ([...listedControls].some((c) => node.contains(c))) return { index, keep: false, reason: "contains listed controls" };
      label = shortText(
        node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          (node as HTMLElement).innerText ||
          node.querySelector("img[alt]")?.getAttribute("alt")
      );
    }
    if (claimed.has(node) && !surface) return { index, keep: false, reason: "duplicate" };
    claimed.add(node);

    const editable = node instanceof HTMLElement && node.isContentEditable;
    // A text-box-shaped widget that is not editable is most likely a custom picker: a button.
    const actsAs = editable ? "textbox" : role === "textbox" && !surface ? "button" : role;
    const cell = surface ? `${Math.round(x / 16)},${Math.round(y / 16)}` : "widget";
    const id = visionId(node, cell);
    pointTargets.set(id, { x, y, node });
    const selected = ["aria-pressed", "aria-selected", "aria-checked"].some((name) => node.getAttribute(name) === "true");
    return { index, keep: true, id, label, role: actsAs, surface: surface ?? "widget", ...(selected ? { selected } : {}) };
  });
}

/** Pointer, mouse and click events at a point, the way a real click arrives: canvas apps read the coordinates. */
function clickAt(target: PointTarget): Element {
  const hit = document.elementFromPoint(target.x, target.y);
  if (!hit || !(hit === target.node || target.node.contains(hit))) {
    throw new Error("the page changed under that spot since it was seen; look again");
  }
  const base = { bubbles: true, cancelable: true, composed: true, clientX: target.x, clientY: target.y, button: 0, view: window };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  hit.dispatchEvent(new PointerEvent("pointerdown", pointer));
  hit.dispatchEvent(new MouseEvent("mousedown", base));
  if (target.node instanceof HTMLElement) target.node.focus({ preventScroll: true });
  hit.dispatchEvent(new PointerEvent("pointerup", pointer));
  hit.dispatchEvent(new MouseEvent("mouseup", base));
  hit.dispatchEvent(new MouseEvent("click", { ...base, detail: 1 }));
  return hit;
}

function resolveTarget(id: string): Element {
  const el = registry.get(id);
  if (!el || !el.isConnected) {
    throw new Error(`target ${id} not found in the current snapshot (page changed?)`);
  }
  return el;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  // Go through the prototype setter so React/Vue controlled inputs notice the change.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(el, text) : (el.value = text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function executeAction(command: ActionCommand, sensitive = false): Promise<ExecutionResult> {
  // Risky actions (log in, submit, pay, delete...) are confirmed by the user in the background
  // before they reach this point (see riskyAction in shared/messages.ts).
  switch (command.action) {
    case "click": {
      const point = pointTargets.get(command.target);
      if (point) {
        clickAt(point);
        return { ok: true, message: `clicked at (${Math.round(point.x)}, ${Math.round(point.y)}): found by vision` };
      }
      const el = resolveTarget(command.target);
      el.scrollIntoView({ block: "center", inline: "center" });
      (el as HTMLElement).click();
      return { ok: true };
    }
    case "type": {
      const point = pointTargets.get(command.target);
      // A vision-only field: click it, then type into whatever took the focus.
      if (point) clickAt(point);
      const el = point ? (document.activeElement ?? point.node) : resolveTarget(command.target);
      if (el instanceof HTMLInputElement && el.type === "file") {
        return { ok: false, message: `${command.target} is a file-upload field: it takes a saved file, not text` };
      }
      (el as HTMLElement).focus();
      if (sensitive) filledFromProfile.add(el);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, command.text);
      } else if ((el as HTMLElement).isContentEditable) {
        el.textContent = command.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        return { ok: false, message: `target ${command.target} is not editable` };
      }
      if (command.submit) {
        const form = (el as HTMLInputElement).form;
        form ? form.requestSubmit() : el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      return { ok: true };
    }
    case "scroll": {
      const amount = command.amountPx ?? window.innerHeight * 0.8;
      window.scrollBy({ top: command.direction === "down" ? amount : -amount, behavior: "smooth" });
      return { ok: true };
    }
    case "navigate": {
      location.assign(command.url);
      return { ok: true };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, command.ms));
      return { ok: true };
    }
    case "done":
    case "ask_user":
    case "noop": {
      console.info(LOG, command.action, command);
      return { ok: true, message: `${command.action}: nothing to execute on the page` };
    }
    default: {
      const exhaustive: never = command;
      return { ok: false, message: `unknown action ${(exhaustive as ActionCommand).action}` };
    }
  }
}

/**
 * Put a saved file into a file-upload field, as if the user had chosen it. The bytes come from
 * the extension's own storage and go only into this page's field.
 */
export function uploadFile(target: string, file: { name: string; type: string; dataBase64: string }): ExecutionResult {
  const el = resolveTarget(target);
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    return { ok: false, message: `target ${target} is not a file-upload field` };
  }
  const binary = atob(file.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], file.name, { type: file.type }));
  el.scrollIntoView({ block: "center", inline: "center" });
  el.files = transfer.files;
  filledFromProfile.add(el);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
  const respond = async (): Promise<ContentResponse> => {
    switch (message.type) {
      case "PING":
        return { type: "PONG" };
      case "CAPTURE_DOM":
        return { type: "DOM_SNAPSHOT", snapshot: captureDom(message.includeText === true, message.frame) };
      case "EXECUTE_ACTION":
        return { type: "EXECUTION_RESULT", result: await executeAction(message.command, message.sensitive === true) };
      case "UPLOAD_FILE":
        return { type: "EXECUTION_RESULT", result: uploadFile(message.target, message.file) };
      case "PROBE_POINTS":
        return { type: "PROBE_RESULT", probes: probePoints(message.points) };
      default:
        return { type: "ERROR", message: `unknown message ${(message as { type: string }).type}` };
    }
  };

  respond()
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ type: "ERROR", message: String(err) }));
  return true; // async response
});

console.debug(LOG, "ready on", location.origin);
