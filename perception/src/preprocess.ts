/**
 * Image -> tensor. Pure TypeScript so it behaves identically in a service worker and in Node.
 *
 * UltraFace expects RGB, NCHW, float32, normalised as (x - 127) / 128, at the network's fixed
 * input size (320x240 or 640x480 depending on the export). Aspect ratio is not preserved: the
 * upstream reference code does a plain resize, boxes come back normalised to [0, 1], and we map
 * them onto the original image, so distortion cancels out.
 */
import type { RawImage } from "./types";

/**
 * Integer-factor box downsample (average of factor x factor blocks). Used before bilinear
 * resizing when shrinking by 2x or more, so small faces do not alias away.
 */
export function downsampleBox(src: RawImage, factor: number): RawImage {
  if (factor <= 1) return src;
  const dstW = Math.max(1, Math.floor(src.width / factor));
  const dstH = Math.max(1, Math.floor(src.height / factor));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const area = factor * factor;
  const { data, width } = src;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          a += data[i + 3]!;
        }
      }
      const o = (y * dstW + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = a / area;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Bilinear resize of an RGBA bitmap. */
export function resizeBilinear(src: RawImage, dstW: number, dstH: number): RawImage {
  if (src.width === dstW && src.height === dstH) return src;
  const { data, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = sw / dstW;
  const yRatio = sh / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c]! * (1 - fx) + data[i01 + c]! * fx;
        const bottom = data[i10 + c]! * (1 - fx) + data[i11 + c]! * fx;
        out[o + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Resize to an exact size with an anti-aliasing pre-pass when shrinking a lot. */
export function resizeForModel(src: RawImage, dstW: number, dstH: number): RawImage {
  const factor = Math.floor(Math.min(src.width / dstW, src.height / dstH));
  const pre = factor >= 2 ? downsampleBox(src, factor) : src;
  return resizeBilinear(pre, dstW, dstH);
}

/** RGBA bitmap -> float32 CHW tensor data (RGB only), normalised for UltraFace. */
export function toNchwFloat32(image: RawImage, mean = 127, scale = 1 / 128): Float32Array {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = (data[p]! - mean) * scale;
    out[plane + i] = (data[p + 1]! - mean) * scale;
    out[2 * plane + i] = (data[p + 2]! - mean) * scale;
  }
  return out;
}

/** Full preprocessing: resize + normalise. Returns NCHW data for shape [1, 3, inputHeight, inputWidth]. */
export function preprocess(image: RawImage, inputWidth: number, inputHeight: number): Float32Array {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error(
      `preprocess: RGBA buffer length ${image.data.length} does not match ${image.width}x${image.height}x4`
    );
  }
  return toNchwFloat32(resizeForModel(image, inputWidth, inputHeight));
}
