/**
 * Privacy / redaction layer.
 *
 * Three sources of sensitive regions feed one black-box mask:
 *   ml         faces from the on-device UltraFace detector          (screenshot px)
 *   dom        password / payment fields, from the DOM summary      (CSS px)
 *   heuristic  emails, phones, card and ID numbers found in page
 *              text and typed input values by the content script    (CSS px)
 *
 * `redact()` paints an opaque black box over every region, plus a safety margin, on a fresh
 * copy of the screenshot. Black boxes rather than blur because blur can be partially inverted.
 * Element labels and attributes carrying PII are replaced with "[REDACTED]".
 *
 * Coordinate spaces: detector output and `redact()` work in screenshot pixels; the wire
 * `RedactedRegion` is in CSS pixels. `toCssPixels` / `toScreenshotPixels` convert.
 */
import type { BoundingBox, RedactedRegion, UIElement } from "@odpa/shared";

import { classifyField, redactText } from "./pii";
import type { PerceptionOutput, RawImage, SensitiveRegion } from "./types";

export { REDACTED_TEXT, redactText } from "./pii";

// ---------------------------------------------------------------------------
// Pixel masking
// ---------------------------------------------------------------------------

export interface RedactOptions {
  /** Margin added to each side, as a fraction of the box's own width/height. Default 0.15. */
  padding?: number;
  /** Margin never shrinks below this many pixels per side, so tiny boxes still get a border. Default 4. */
  minPaddingPx?: number;
  /** RGBA fill. Default opaque black. */
  fill?: readonly [number, number, number, number];
  /**
   * After the masked copy is made, overwrite the *source* buffer with zeros so the unmasked
   * pixels stop existing as soon as possible. Default false (pure function); the pipeline in
   * `sanitize()` turns it on.
   */
  wipeSource?: boolean;
}

export interface RedactResult {
  /** Masked copy when anything was painted; the very same input object when nothing was. */
  image: RawImage;
  /** The padded, clamped, integer-aligned regions that were actually painted (screenshot px). */
  masked: SensitiveRegion[];
  changed: boolean;
}

export const DEFAULT_REDACT_OPTIONS: Required<RedactOptions> = {
  padding: 0.15,
  minPaddingPx: 4,
  fill: [0, 0, 0, 255],
  wipeSource: false,
};

/**
 * Grow a detection box by the safety margin and snap it outward to whole pixels, clamped to
 * the image. Returns null for boxes that end up empty (fully outside the image).
 */
export function padRegion(
  bbox: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  padding = DEFAULT_REDACT_OPTIONS.padding,
  minPaddingPx = DEFAULT_REDACT_OPTIONS.minPaddingPx
): BoundingBox | null {
  const padX = Math.max(minPaddingPx, bbox.width * padding);
  const padY = Math.max(minPaddingPx, bbox.height * padding);
  const x0 = clamp(Math.floor(bbox.x - padX), 0, imageWidth);
  const y0 = clamp(Math.floor(bbox.y - padY), 0, imageHeight);
  const x1 = clamp(Math.ceil(bbox.x + bbox.width + padX), 0, imageWidth);
  const y1 = clamp(Math.ceil(bbox.y + bbox.height + padY), 0, imageHeight);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Margin for boxes with exact geometry (DOM fields, text ranges). Their edges are already
 * pixel-accurate, so the margin only covers anti-aliasing and focus rings: a fraction of the
 * box *height* on every side. Scaling by width, as for detector boxes, would spill a wide input
 * field's mask across the page.
 */
export function padExactRegion(
  bbox: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  padding = DEFAULT_REDACT_OPTIONS.padding,
  minPaddingPx = DEFAULT_REDACT_OPTIONS.minPaddingPx
): BoundingBox | null {
  const pad = Math.max(minPaddingPx, bbox.height * padding);
  return padRegion(bbox, imageWidth, imageHeight, 0, pad);
}

/**
 * Black out every region (with margin) on a new copy of `image`. Detector boxes (method "ml")
 * are estimates and get `padding` x their own width/height per side; exact DOM/text boxes get
 * `padExactRegion`.
 *
 * - Never paints into the input buffer. With `wipeSource`, the input buffer is zeroed after
 *   the copy is taken.
 * - With no usable regions the input object is returned as-is and `changed` is false: that is
 *   a real "nothing sensitive found" result, since `runInference` throws when no model ran.
 */
export function redact(
  image: RawImage,
  regions: readonly SensitiveRegion[],
  options: RedactOptions = {}
): RedactResult {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(`redact: RGBA buffer length ${data.length} does not match ${width}x${height}x4`);
  }
  const opts = { ...DEFAULT_REDACT_OPTIONS, ...options };

  const masked: SensitiveRegion[] = [];
  for (const region of regions) {
    const bbox =
      region.method === "ml"
        ? padRegion(region.bbox, width, height, opts.padding, opts.minPaddingPx)
        : padExactRegion(region.bbox, width, height, opts.padding, opts.minPaddingPx);
    if (bbox) masked.push({ ...region, bbox });
  }
  if (masked.length === 0) {
    return { image, masked, changed: false };
  }

  const out = new Uint8ClampedArray(data); // copy first; the source is never painted
  const [r, g, b, a] = opts.fill;
  for (const { bbox } of masked) {
    const rowEnd = bbox.y + bbox.height;
    for (let y = bbox.y; y < rowEnd; y++) {
      let i = (y * width + bbox.x) * 4;
      const end = i + bbox.width * 4;
      for (; i < end; i += 4) {
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = a;
      }
    }
  }

  if (opts.wipeSource) data.fill(0);

  return { image: { width, height, data: out }, masked, changed: true };
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

/** Screenshot pixels -> CSS pixels (wire format). */
export function toCssPixels(regions: readonly SensitiveRegion[], devicePixelRatio: number): RedactedRegion[] {
  const s = devicePixelRatio > 0 ? 1 / devicePixelRatio : 1;
  return regions.map((region) => ({
    bbox: scaleBox(region.bbox, s),
    category: region.category,
    confidence: region.confidence,
    method: region.method,
  }));
}

/** CSS pixels -> screenshot pixels (for DOM-derived regions that should also be masked). */
export function toScreenshotPixels(regions: readonly RedactedRegion[], devicePixelRatio: number): SensitiveRegion[] {
  const s = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return regions.map((region) => ({
    bbox: scaleBox(region.bbox, s),
    category: region.category,
    confidence: region.confidence,
    method: region.method,
  }));
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

export interface RedactionInput {
  /** Decoded screenshot, or null when pixels are not being sent this step. */
  screenshot: RawImage | null;
  /** DOM summary produced by the content script (labels NOT yet redacted). */
  elements: UIElement[];
  /** Output of the on-device detector for this frame (regions in screenshot pixel space). */
  perception: PerceptionOutput;
  /**
   * PII found by the content script in visible page text and typed input values, in CSS
   * pixels. The text itself never leaves the content script; only the boxes do.
   */
  textRegions?: RedactedRegion[];
  /** Needed to map CSS-pixel bboxes onto screenshot pixels and back. */
  devicePixelRatio: number;
}

export interface RedactionResult {
  /** Masked screenshot (new buffer), the untouched input when nothing needed masking, or null. */
  screenshot: RawImage | null;
  /** Elements with PII in labels/attributes replaced by "[REDACTED]". */
  elements: UIElement[];
  /** What was hidden, in CSS pixels, for the server's benefit. */
  redactions: RedactedRegion[];
}

/**
 * Full redaction pipeline: detector regions (+ DOM regions once implemented) -> black boxes on
 * the pixels -> CSS-pixel bookkeeping for the wire payload.
 *
 * Consumes the screenshot: when anything is masked the *input* buffer is zeroed, so callers
 * must use `result.screenshot` from here on. Keep this the single "do everything" entry point
 * so the trust boundary stays easy to audit.
 */
export async function sanitize(input: RedactionInput): Promise<RedactionResult> {
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  const domRegions = [...detectSensitiveDomRegions(input.elements), ...(input.textRegions ?? [])]; // CSS px
  const mlRegions = input.perception.sensitiveRegions; // screenshot px

  let screenshot = input.screenshot;
  let masked: SensitiveRegion[] = [];
  if (screenshot) {
    const result = redact(screenshot, [...mlRegions, ...toScreenshotPixels(domRegions, dpr)], { wipeSource: true });
    screenshot = result.image;
    masked = result.masked;
  }

  // Report the padded boxes that were actually painted. Without a screenshot no detector ran,
  // so only DOM-derived regions can exist.
  const redactions = screenshot ? toCssPixels(masked, dpr) : domRegions;
  const elements = redactElements(input.elements, redactions);

  return { screenshot, elements, redactions };
}

// ---------------------------------------------------------------------------
// DOM / text redaction
// ---------------------------------------------------------------------------

/**
 * Password, PIN, OTP and payment-card fields, judged from type / autocomplete / label /
 * placeholder / name (the DOM summary never carries values). One region per field, CSS px.
 */
export function detectSensitiveDomRegions(elements: UIElement[]): RedactedRegion[] {
  const regions: RedactedRegion[] = [];
  for (const el of elements) {
    if (!el.isVisible) continue;
    const category = classifyField(el);
    if (!category) continue;
    regions.push({ bbox: el.bbox, category, confidence: 1, method: "dom" });
  }
  return regions;
}

/** Attributes whose values are free text that could carry PII. */
const TEXT_ATTRIBUTES = ["placeholder", "aria-label", "title", "alt", "name"];

/**
 * Replace PII in element labels and free-text attributes with "[REDACTED]" and mark the element
 * `redacted: true`. Returns new objects; the input array is not modified.
 */
export function redactElements(elements: UIElement[], _regions: RedactedRegion[]): UIElement[] {
  return elements.map((el) => {
    const label = redactText(el.label);
    let changed = label.redacted;
    let attributes = el.attributes;
    if (attributes) {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(attributes)) {
        if (TEXT_ATTRIBUTES.includes(k)) {
          const r = redactText(v);
          changed ||= r.redacted;
          next[k] = r.text;
        } else {
          next[k] = v;
        }
      }
      attributes = next;
    }
    if (!changed) return el;
    const out: UIElement = { ...el, label: label.text, redacted: true };
    if (attributes) out.attributes = attributes;
    return out;
  });
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function scaleBox(b: BoundingBox, s: number): BoundingBox {
  return {
    x: round1(b.x * s),
    y: round1(b.y * s),
    width: round1(b.width * s),
    height: round1(b.height * s),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
