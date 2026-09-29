/**
 * Privacy / redaction layer.
 *
 * Pixel redaction is REAL: `redact()` paints an opaque black box over every sensitive region,
 * plus a safety margin, on a fresh copy of the screenshot. Black boxes rather than blur because
 * blur can be partially inverted; a solid fill destroys the information outright.
 *
 * Still TODO (see the tagged stubs at the bottom):
 *   TODO(redaction-dom)   flag password/payment/contact fields from the DOM summary
 *   TODO(redaction-text)  mask emails, phone numbers, card numbers in labels and attributes
 *
 * Coordinate spaces: detector output and `redact()` work in screenshot pixels; the wire
 * `RedactedRegion` is in CSS pixels. `toCssPixels` / `toScreenshotPixels` convert.
 */
import type { BoundingBox, RedactedRegion, UIElement } from "@odpa/shared";

import type { PerceptionOutput, RawImage, SensitiveRegion } from "./types";

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
 * Black out every region (with margin) on a new copy of `image`.
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
    const bbox = padRegion(region.bbox, width, height, opts.padding, opts.minPaddingPx);
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
  /** Needed to map CSS-pixel bboxes onto screenshot pixels and back. */
  devicePixelRatio: number;
}

export interface RedactionResult {
  /** Masked screenshot (new buffer), the untouched input when nothing needed masking, or null. */
  screenshot: RawImage | null;
  /** Elements with sensitive labels/attributes replaced by placeholders (still TODO). */
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
  const domRegions = detectSensitiveDomRegions(input.elements); // CSS px, TODO(redaction-dom)
  const mlRegions = input.perception.sensitiveRegions; // screenshot px, real

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
// DOM / text redaction: still stubs
// ---------------------------------------------------------------------------

/** Text used in place of a masked label/attribute value. */
export const REDACTED_TEXT = "[REDACTED]";

/**
 * TODO(redaction-text): text-level PII detection (emails, phones, card numbers via Luhn,
 * national ids, street addresses). Return the category so callers can populate
 * RedactedRegion.category. Currently a pass-through.
 */
export function redactText(text: string): { text: string; redacted: boolean } {
  return { text, redacted: false };
}

/**
 * TODO(redaction-dom): flag input[type=password], input[autocomplete^="cc-"], email/tel inputs
 * and elements whose label/placeholder matches "password", "ssn", "card", ... and emit a
 * RedactedRegion (method "dom", CSS px) per element. Currently returns nothing.
 */
export function detectSensitiveDomRegions(_elements: UIElement[]): RedactedRegion[] {
  return [];
}

/**
 * TODO(redaction-dom): replace `label` / offending `attributes` with REDACTED_TEXT for elements
 * intersecting a redaction region or tripping `redactText`, and set `redacted: true`.
 * Currently returns the elements unchanged.
 */
export function redactElements(elements: UIElement[], _regions: RedactedRegion[]): UIElement[] {
  return elements;
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
