/**
 * Image plumbing for the background worker: data-URL <-> RawImage.
 * Uses OffscreenCanvas, which is available in both Chrome service workers and Firefox
 * background scripts.
 */
import type { RawImage } from "@odpa/perception";
import type { SanitizedScreenshot, ScreenshotMimeType } from "@odpa/shared";

/** Decode a `data:image/...;base64,...` URL (from chrome.tabs.captureVisibleTab) into RGBA. */
export async function decodeDataUrl(dataUrl: string): Promise<RawImage> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/** Encode a (redacted) RawImage back into the wire format. */
export async function encodeRawImage(
  image: RawImage,
  mimeType: ScreenshotMimeType,
  quality: number
): Promise<SanitizedScreenshot> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  // TS 5.9 types ImageData's buffer as ArrayBuffer-only; our RGBA buffer is never shared.
  const pixels = image.data as Uint8ClampedArray<ArrayBuffer>;
  ctx.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);

  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    mimeType,
    dataBase64: bytesToBase64(bytes),
    width: image.width,
    height: image.height,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack limits on large screenshots.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
