/** Text-level PII detection, field classification and label redaction. No model needed. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UIElement } from "@odpa/shared";

import { classifyField, findPii, luhnValid, redactText, scrubUrl } from "../src/pii";
import { detectSensitiveDomRegions, redactElements, sanitize } from "../src/redaction";

const kinds = (text: string) => findPii(text).map((m) => `${m.kind}:${text.slice(m.start, m.end)}`);

test("finds the demo page's sample PII", () => {
  assert.deepEqual(kinds("Email jane.doe@example.com"), ["email:jane.doe@example.com"]);
  assert.deepEqual(kinds("Phone +91 98765 43210"), ["phone:+91 98765 43210"]);
  assert.deepEqual(kinds("Card 4111 1111 1111 1111"), ["card:4111 1111 1111 1111"]);
  assert.deepEqual(kinds("Aadhaar 2345 6789 0123"), ["aadhaar:2345 6789 0123"]);
  assert.deepEqual(kinds("PAN ABCDE1234F"), ["pan:ABCDE1234F"]);
  assert.deepEqual(kinds("SSN 123-45-6789"), ["ssn:123-45-6789"]);
  assert.deepEqual(kinds("call (415) 555-0132 today"), ["phone:(415) 555-0132"]);
});

test("does not fire on ordinary text and numbers", () => {
  for (const text of [
    "Submit the contact form",
    "Order 12345 shipped on 2026-09-29",
    "Total: 1,299.00 INR",
    "Version 1.29.0 released",
    "4111 1111 1111 1112", // fails Luhn
    "Room 101, floor 3",
    "Copyright 2026",
  ]) {
    assert.deepEqual(findPii(text), [], text);
  }
});

test("luhnValid", () => {
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("5500005555555559"), true);
  assert.equal(luhnValid("4111111111111112"), false);
});

test("redactText replaces every span and reports categories", () => {
  const r = redactText("Contact jane@x.io or +1 415 555 0132");
  assert.equal(r.text, "Contact [REDACTED] or [REDACTED]");
  assert.equal(r.redacted, true);
  assert.deepEqual(r.categories.sort(), ["email", "phone"]);
  assert.deepEqual(redactText("Submit"), { text: "Submit", redacted: false, categories: [] });
});

test("scrubUrl drops query and fragment and PII in the path", () => {
  assert.equal(scrubUrl("http://127.0.0.1:5500/"), "http://127.0.0.1:5500/");
  assert.equal(scrubUrl("https://mail.example.com/u/jane@x.io/inbox?token=abc#msg"), "https://mail.example.com/u/[REDACTED]/inbox?[REDACTED]#[REDACTED]");
});

test("classifyField flags password, OTP and card fields only", () => {
  const f = (label: string, attributes: Record<string, string> = {}, role = "textbox") => classifyField({ role, label, attributes });
  assert.equal(f("Account password", { type: "password" }), "credential");
  assert.equal(f("Code", { autocomplete: "one-time-code" }), "credential");
  assert.equal(f("Card", { autocomplete: "cc-number" }), "payment_card");
  assert.equal(f("Card number"), "payment_card");
  assert.equal(f("Enter your PIN"), "credential");
  assert.equal(f("Email", { type: "email" }), null);
  assert.equal(f("Name"), null);
  assert.equal(f("Password", {}, "button"), null);
});

const el = (id: string, role: UIElement["role"], label: string, attributes?: Record<string, string>): UIElement => ({
  id,
  role,
  label,
  bbox: { x: 10, y: 10, width: 200, height: 30 },
  isVisible: true,
  isInteractive: true,
  ...(attributes ? { attributes } : {}),
});

test("DOM regions and label redaction", () => {
  const elements = [
    el("el_0", "textbox", "Account password", { type: "password" }),
    el("el_1", "link", "jane.doe@example.com"),
    el("el_2", "button", "Submit"),
    el("el_3", "textbox", "Email", { type: "email", placeholder: "you@example.com" }),
  ];
  const regions = detectSensitiveDomRegions(elements);
  assert.deepEqual(regions.map((r) => [r.category, r.method]), [["credential", "dom"]]);

  const out = redactElements(elements, regions);
  assert.equal(out[1]!.label, "[REDACTED]");
  assert.equal(out[1]!.redacted, true);
  assert.equal(out[2], elements[2], "untouched elements are returned as-is");
  assert.equal(out[3]!.attributes!.placeholder, "[REDACTED]");
  assert.equal(elements[1]!.label, "jane.doe@example.com", "input not mutated");
});

test("sanitize() blacks out DOM and text regions in the pixels", async () => {
  const width = 400;
  const height = 200;
  const data = new Uint8ClampedArray(width * height * 4).fill(200);
  const result = await sanitize({
    screenshot: { width, height, data },
    elements: [el("el_0", "textbox", "Password", { type: "password" })],
    perception: { modelId: "test", latencyMs: 0, sensitiveRegions: [], uiElements: [] },
    textRegions: [{ bbox: { x: 100, y: 60, width: 80, height: 16 }, category: "email", confidence: 0.99, method: "heuristic" }],
    devicePixelRatio: 2,
  });
  assert.deepEqual(result.redactions.map((r) => r.method).sort(), ["dom", "heuristic"]);
  const px = (x: number, y: number) => Array.from(result.screenshot!.data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
  // CSS (10,10)+(200x30) at dpr 2 is screenshot (20,20)+(400x60); the password field covers (30,30).
  assert.deepEqual(px(30, 30), [0, 0, 0, 255]);
  // CSS email box (100..180, 60..76) is screenshot (200..360, 120..152).
  assert.deepEqual(px(260, 135), [0, 0, 0, 255]);
  // Far from both boxes: untouched.
  assert.deepEqual(px(5, 190), [200, 200, 200, 200]);
  // Wire regions are back in CSS px.
  const email = result.redactions.find((r) => r.method === "heuristic")!;
  assert.ok(email.bbox.x <= 100 && email.bbox.y <= 60 && email.bbox.x + email.bbox.width >= 180);
});
