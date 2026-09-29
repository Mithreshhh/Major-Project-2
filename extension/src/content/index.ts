/**
 * Content script: runs inside every http(s) page.
 *
 * Responsibilities
 *   - CAPTURE_DOM      build a compact, PII-conscious summary of the visible UI
 *   - EXECUTE_ACTION   carry out an ActionCommand the server returned
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
    if (el instanceof HTMLInputElement && ["password", "hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file"].includes(el.type)) {
      continue; // password fields are handled by the DOM rules; the rest carry no typed text
    }
    const value = el.value;
    if (!value) continue;
    const matches = findPii(value);
    const typed = el instanceof HTMLInputElement && (el.type === "email" || el.type === "tel");
    if (matches.length === 0 && !typed) continue;
    const bbox = bboxOf(el);
    if (!inViewport(bbox)) continue;
    const category = matches[0]?.category ?? ((el as HTMLInputElement).type === "tel" ? "phone" : "email");
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

export function captureDom(includeText = false): DomSnapshot {
  registry = new Map();
  const elements: UIElement[] = [];

  for (const el of document.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (elements.length >= MAX_ELEMENTS) break;

    const bbox = bboxOf(el);
    const visible = isVisible(el, bbox);
    if (!visible) continue; // off-screen elements are not useful to a screenshot-grounded VLM

    const role = roleOf(el);
    if (role === "text" && !(el.textContent ?? "").trim()) continue; // empty status region
    const id = `el_${elements.length}`;
    registry.set(id, el);

    const element: UIElement = {
      id,
      role,
      label: labelOf(el),
      bbox,
      isVisible: visible,
      isInteractive: isInteractive(el, role),
    };
    const attributes = safeAttributes(el);
    if (attributes) element.attributes = attributes;
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

export async function executeAction(command: ActionCommand): Promise<ExecutionResult> {
  // Risky actions (log in, submit, pay, delete...) are confirmed by the user in the background
  // before they reach this point (see riskyAction in shared/messages.ts).
  switch (command.action) {
    case "click": {
      const el = resolveTarget(command.target);
      el.scrollIntoView({ block: "center", inline: "center" });
      (el as HTMLElement).click();
      return { ok: true };
    }
    case "type": {
      const el = resolveTarget(command.target);
      (el as HTMLElement).focus();
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

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
  const respond = async (): Promise<ContentResponse> => {
    switch (message.type) {
      case "PING":
        return { type: "PONG" };
      case "CAPTURE_DOM":
        return { type: "DOM_SNAPSHOT", snapshot: captureDom(message.includeText === true) };
      case "EXECUTE_ACTION":
        return { type: "EXECUTION_RESULT", result: await executeAction(message.command) };
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
