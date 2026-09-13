/**
 * Privacy / redaction layer.
 *
 * Status: SCAFFOLD. Every function here is a pass-through with clearly marked TODOs.
 *
 * !!! Until the TODO(redaction) items are implemented, NOTHING IS ACTUALLY REDACTED. !!!
 * Do not point the extension at a remote server with real pages until this module is done.
 *
 * Design: three complementary detectors feed one mask step.
 *
 *   DOM heuristics  (cheap, exact)   -> input[type=password], autocomplete="cc-number", ...
 *   text heuristics (cheap, fuzzy)   -> regexes for emails, phones, card numbers, ...
 *   ML detector     (costly, visual) -> regions the ViT / a small face detector flags
 *                                        (uses PerceptionOutput.regions)
 *
 * All three produce `RedactedRegion`s in *CSS pixel / viewport* space; `maskRegions` maps them
 * onto the screenshot using devicePixelRatio and paints over them. Element labels are masked
 * separately by `redactElements`.
 */
import type { RedactedRegion, UIElement } from "@odpa/shared";

import type { PerceptionOutput, RawImage } from "./types";

export interface RedactionInput {
  /** Decoded screenshot, or null when pixels are not being sent this step. */
  screenshot: RawImage | null;
  /** DOM summary produced by the content script (labels NOT yet redacted). */
  elements: UIElement[];
  /** Output of the on-device model for this frame (regions in screenshot pixel space). */
  perception: PerceptionOutput;
  /** Needed to map CSS-pixel bboxes onto screenshot pixels. */
  devicePixelRatio: number;
}

export interface RedactionResult {
  /** Screenshot with sensitive regions painted over (same buffer as input, mutated in place). */
  screenshot: RawImage | null;
  /** Elements with sensitive labels/attributes replaced by placeholders. */
  elements: UIElement[];
  /** What was hidden (sent to the server as metadata). */
  redactions: RedactedRegion[];
}

/** Text used in place of a masked label/attribute value. */
export const REDACTED_TEXT = "[REDACTED]";

/**
 * Redact a single string.
 *
 * TODO(redaction): implement text-level PII detection. Suggested first pass:
 *   - email, phone, IBAN / card number (Luhn), national id patterns, street addresses
 *   - return the category so the caller can populate RedactedRegion.category
 * Consider a tiny on-device NER model later if regexes prove insufficient.
 */
export function redactText(text: string): { text: string; redacted: boolean } {
  return { text, redacted: false };
}

/**
 * Find sensitive regions using DOM structure alone (no ML).
 *
 * TODO(redaction): flag elements such as
 *   - input[type=password], input[autocomplete^="cc-"], input[type=email|tel]
 *   - elements whose label/placeholder matches "password", "ssn", "card", ...
 * and emit a RedactedRegion (method: "dom") for each, using the element's bbox.
 */
export function detectSensitiveDomRegions(_elements: UIElement[]): RedactedRegion[] {
  return [];
}

/**
 * Turn model detections into redaction regions.
 *
 * TODO(redaction): map `perception.regions` with labels like "face", "id_card", "text_dense"
 * into RedactedRegions (method: "ml"), converting screenshot pixels -> CSS pixels via
 * `1 / devicePixelRatio`. Apply per-category confidence thresholds.
 */
export function detectSensitiveMlRegions(
  _perception: PerceptionOutput,
  _devicePixelRatio: number
): RedactedRegion[] {
  return [];
}

/**
 * Paint over `regions` in the screenshot.
 *
 * TODO(redaction): implement in-place masking:
 *   - convert each CSS-pixel bbox to screenshot pixels (multiply by devicePixelRatio),
 *   - clamp to image bounds, add a small padding,
 *   - fill with solid black (or pixelate) directly in `image.data` (RGBA, row-major).
 * Mutating in place avoids a second copy of the frame in memory.
 */
export function maskRegions(image: RawImage, _regions: RedactedRegion[], _devicePixelRatio: number): RawImage {
  return image;
}

/**
 * Replace sensitive labels / attribute values in the DOM summary.
 *
 * TODO(redaction): for every element that intersects a redaction region or whose text trips
 * `redactText`, replace `label` (and offending `attributes` values) with REDACTED_TEXT and set
 * `redacted: true`. Never forward raw form *values*; the content script already omits them.
 */
export function redactElements(elements: UIElement[], _regions: RedactedRegion[]): UIElement[] {
  return elements;
}

/**
 * Full redaction pipeline: detect (DOM + text + ML) -> mask pixels -> mask labels.
 * This is the single entry point the extension calls; keep it the only public "do everything"
 * function so the trust boundary is easy to audit.
 */
export async function sanitize(input: RedactionInput): Promise<RedactionResult> {
  const regions: RedactedRegion[] = [
    ...detectSensitiveDomRegions(input.elements),
    ...detectSensitiveMlRegions(input.perception, input.devicePixelRatio),
  ];

  // TODO(redaction): merge overlapping regions before masking to avoid double work.

  const screenshot = input.screenshot
    ? maskRegions(input.screenshot, regions, input.devicePixelRatio)
    : null;

  const elements = redactElements(input.elements, regions);

  return { screenshot, elements, redactions: regions };
}
