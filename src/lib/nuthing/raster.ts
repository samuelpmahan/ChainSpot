/**
 * NuThing P1 raster layer: RGBA input contract plus the exact OpenCV
 * bright/dark thresholding used by scripts/nuthing-p1-canonical.py.
 *
 * The Python baseline computes HSV via cv2.cvtColor(..., COLOR_RGB2HSV) on
 * uint8 data. OpenCV's 8-bit path is fixed point: V = max(R,G,B) and
 * S = ((V - min) * sdiv[V] + 2^11) >> 12 with sdiv[v] = cvRound((255<<12)/v).
 * We reproduce that table exactly (cvRound = round half to even) so borderline
 * pixels land on the same side of the S threshold as the baseline.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. Alpha is ignored by the pipeline. */
  data: Uint8Array | Uint8ClampedArray;
}

/** Binary mask stored one byte per pixel (0/1), row-major. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export const BRIGHT_V_MIN = 210;
export const BRIGHT_S_MAX = 45;
export const DARK_V_MAX = 45;

function roundHalfToEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const HSV_SHIFT = 12;
const sdivTable: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let i = 1; i < 256; i++) {
    t[i] = roundHalfToEven((255 << HSV_SHIFT) / i);
  }
  return t;
})();

/** OpenCV 8-bit HSV saturation for one pixel. */
export function opencvSaturation(r: number, g: number, b: number): number {
  const v = Math.max(r, g, b);
  const vmin = Math.min(r, g, b);
  const diff = v - vmin;
  return (diff * sdivTable[v] + (1 << (HSV_SHIFT - 1))) >> HSV_SHIFT;
}

export interface BrightDarkMasks {
  bright: Mask;
  dark: Mask;
}

/**
 * bright = (V >= 210) & (S <= 45); dark = (V <= 45), matching the baseline's
 * BRIGHT_V_MIN / BRIGHT_S_MAX / DARK_V_MAX exactly.
 */
export function computeBrightDarkMasks(image: RgbaImage): BrightDarkMasks {
  const { width, height, data } = image;
  const n = width * height;
  const bright = new Uint8Array(n);
  const dark = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const v = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (v <= DARK_V_MAX) dark[i] = 1;
    if (v >= BRIGHT_V_MIN) {
      const vmin = r < g ? (r < b ? r : b) : g < b ? g : b;
      const s = ((v - vmin) * sdivTable[v] + (1 << (HSV_SHIFT - 1))) >> HSV_SHIFT;
      if (s <= BRIGHT_S_MAX) bright[i] = 1;
    }
  }
  return {
    bright: { width, height, data: bright },
    dark: { width, height, data: dark },
  };
}
