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
import type { ActionCommand, BoundingBox, ElementRole, UIElement } from "@odpa/shared";

import type { ContentRequest, ContentResponse, DomSnapshot, ExecutionResult } from "../shared/messages";

const LOG = "[odpa:content]";
const MAX_ELEMENTS = 200;

/** Attributes that are safe to forward. Everything else (value, href, data-*) is dropped. */
const ATTRIBUTE_WHITELIST = ["type", "placeholder", "aria-label", "role", "title", "name", "alt"];

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

export function captureDom(): DomSnapshot {
  registry = new Map();
  const elements: UIElement[] = [];

  for (const el of document.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (elements.length >= MAX_ELEMENTS) break;

    const bbox = bboxOf(el);
    const visible = isVisible(el, bbox);
    if (!visible) continue; // off-screen elements are not useful to a screenshot-grounded VLM

    const role = roleOf(el);
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
  // TODO(agent): add human-in-the-loop confirmation for destructive actions (submit, navigate)
  // and a visual highlight of the target before acting.
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
        return { type: "DOM_SNAPSHOT", snapshot: captureDom() };
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
