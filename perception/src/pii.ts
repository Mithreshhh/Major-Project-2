/**
 * Text-level PII detection. Pure TypeScript, no dependencies, so the content script can import
 * it (via "@odpa/perception/pii") without pulling ONNX Runtime into the page bundle.
 *
 * Detects, in priority order (earlier patterns win on overlap):
 *   payment_card  13-19 digits with optional spaces/dashes, Luhn-valid
 *   email         local@domain.tld
 *   pii_text      US SSN (123-45-6789), Aadhaar (1234 5678 9012), PAN (ABCDE1234F)
 *   phone         10-15 digits with separators or a leading "+", not a date
 *
 * Regex-based detection is high precision on well-formatted values and will miss unusual
 * formats. It is one layer; the ML detector and DOM rules are the others.
 */
import type { SensitiveCategory } from "@odpa/shared";

export interface PiiMatch {
  start: number;
  end: number;
  category: SensitiveCategory;
  /** Which rule fired, for logs and tests. */
  kind: "card" | "email" | "ssn" | "aadhaar" | "pan" | "phone";
}

export const REDACTED_TEXT = "[REDACTED]";

interface Rule {
  kind: PiiMatch["kind"];
  category: SensitiveCategory;
  pattern: RegExp;
  accept?: (value: string) => boolean;
}

const RULES: Rule[] = [
  {
    kind: "card",
    category: "payment_card",
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    accept: (v) => {
      const digits = v.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    kind: "email",
    category: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  // Grouped-digit IDs must not be a slice of a longer digit run (e.g. a card number failing Luhn).
  { kind: "ssn", category: "pii_text", pattern: /(?<!\d[ -]?)\d{3}-\d{2}-\d{4}(?![ -]?\d)/g },
  { kind: "aadhaar", category: "pii_text", pattern: /(?<!\d[ -]?)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![ -]?\d)/g },
  { kind: "pan", category: "pii_text", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  {
    kind: "phone",
    category: "phone",
    pattern: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?!\w)/g,
    accept: (v) => {
      const digits = v.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) return false;
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(v.trim())) return false; // ISO date
      return v.trim().startsWith("+") || /[\s.()-]/.test(v) || digits.length >= 10;
    },
  },
];

/** Luhn checksum used by payment card numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum > 0 && sum % 10 === 0;
}

/** All non-overlapping PII spans in `text`, sorted by position. */
export function findPii(text: string): PiiMatch[] {
  if (!text || text.length < 6) return [];
  const found: PiiMatch[] = [];
  const overlaps = (s: number, e: number) => found.some((m) => s < m.end && e > m.start);

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const raw = m[0];
      // Trim trailing separators the digit patterns can swallow.
      const value = raw.replace(/[\s.-]+$/, "");
      const start = m.index ?? 0;
      const end = start + value.length;
      if (rule.accept && !rule.accept(value)) continue;
      if (overlaps(start, end)) continue;
      found.push({ start, end, category: rule.category, kind: rule.kind });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Replace every PII span with REDACTED_TEXT. */
export function redactText(text: string): { text: string; redacted: boolean; categories: SensitiveCategory[] } {
  const matches = findPii(text);
  if (matches.length === 0) return { text, redacted: false, categories: [] };
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + REDACTED_TEXT;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, redacted: true, categories: [...new Set(matches.map((m) => m.category))] };
}

/**
 * Keep scheme, host and path; replace query string and fragment, which routinely carry tokens,
 * emails and session ids. PII in the path itself is replaced too.
 */
export function scrubUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(url).text;
  }
  const path = redactText(decodeURIComponent(parsed.pathname)).text;
  const query = parsed.search ? `?${REDACTED_TEXT}` : "";
  const hash = parsed.hash ? `#${REDACTED_TEXT}` : "";
  return `${parsed.origin}${path}${query}${hash}`;
}

// ---------------------------------------------------------------------------
// Field-level rules (used on the DOM summary: no values, only type/label/attributes)
// ---------------------------------------------------------------------------

const CREDENTIAL_HINT = /pass(word|code|phrase)?\b|\bpin\b|\bcvv\b|\bcvc\b|\bssn\b|social security|\botp\b|one[- ]time/i;
const CARD_HINT = /card ?(number|no)|\bcc[-_ ]?(num|number)\b|credit card|debit card/i;

/**
 * Classify a form field as sensitive from what the DOM summary carries (type, autocomplete,
 * label, placeholder, name). Returns null when nothing about the field is sensitive.
 */
export function classifyField(field: {
  role: string;
  label: string;
  attributes?: Record<string, string>;
}): SensitiveCategory | null {
  if (field.role !== "textbox") return null;
  const a = field.attributes ?? {};
  const type = (a.type ?? "").toLowerCase();
  const autocomplete = (a.autocomplete ?? "").toLowerCase();
  const hints = [field.label, a.placeholder, a.name, a["aria-label"]].filter(Boolean).join(" ");

  if (type === "password") return "credential";
  if (/(current|new)-password|one-time-code/.test(autocomplete)) return "credential";
  if (autocomplete.startsWith("cc-")) return "payment_card";
  if (CARD_HINT.test(hints)) return "payment_card";
  if (CREDENTIAL_HINT.test(hints)) return "credential";
  return null;
}
