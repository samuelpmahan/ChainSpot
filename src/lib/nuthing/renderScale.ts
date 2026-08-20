/**
 * Capture-zoom estimation from render identity (CX-058).
 *
 * Basket sprites are screen-space furniture: 42x66 at every map zoom. The
 * C2D dashed ring around each basket is geographic: radius 84 px at the dev
 * render zoom, scaling linearly with zoom. The ratio measures the capture's
 * zoom with no course knowledge: geoScale = 84 / measured ring radius, and
 * the geometry raster is the capture downscaled by that factor, where every
 * dev-tuned geometric constant applies unchanged.
 *
 * Measurement: for each matched sprite center, walk radii outward and score
 * each radius by the fraction of ring samples that are white-family render
 * paint (the C2D dashes) — a sharp peak at the ring radius. Per-basket peaks
 * are combined by median; sub-2% agreement across baskets was measured on
 * both the dev corpus (peak 84) and The Rec (peak ~168).
 */
import type { RgbaImage } from './raster';

export const C2D_RING_RADIUS_DEV_PX = 84;

const R_MIN = 50;
const R_MAX = 260;
const ANGLES = 96;
/** White-family render paint: bright, low saturation (same family as raster.ts BRIGHT). */
function isWhiteFamily(data: Uint8Array | Uint8ClampedArray, p: number): boolean {
  const r = data[p];
  const g = data[p + 1];
  const b = data[p + 2];
  const v = Math.max(r, g, b);
  return v >= 195 && v - Math.min(r, g, b) <= 55;
}

/** Bright-dash fraction on the circle of radius `radius` around (cx, cy). */
function ringWhiteFraction(image: RgbaImage, cx: number, cy: number, radius: number): number {
  let on = 0;
  let total = 0;
  for (let a = 0; a < ANGLES; a++) {
    const th = (a / ANGLES) * 2 * Math.PI;
    const x = Math.round(cx + radius * Math.cos(th));
    const y = Math.round(cy + radius * Math.sin(th));
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) continue;
    total++;
    if (isWhiteFamily(image.data, (y * image.width + x) * 4)) on++;
  }
  return total >= ANGLES / 2 ? on / total : 0;
}

export interface RenderScaleEstimate {
  /** Geometry px per capture px (1 = dev zoom, 0.5 = 2x dev zoom). */
  geoScale: number;
  /** Median measured C2D ring radius, capture px. */
  ringRadiusPx: number;
  /** Per-basket peak radii that voted. */
  perBasketRadiiPx: number[];
}

/**
 * Estimates the capture zoom from matched sprite centers. Sprites with no
 * discernible ring peak (occluded rings, false-positive sprites on ground
 * clutter) abstain; the median over voters is robust to a minority of
 * wrong peaks. Returns null when fewer than 3 sprites vote.
 */
export function estimateRenderScale(
  image: RgbaImage,
  spriteCenters: readonly { cx: number; cy: number }[]
): RenderScaleEstimate | null {
  const radii: number[] = [];
  for (const s of spriteCenters) {
    let bestR = 0;
    let bestF = 0;
    for (let r = R_MIN; r <= R_MAX; r += 2) {
      const f = ringWhiteFraction(image, s.cx, s.cy, r);
      if (f > bestF) {
        bestF = f;
        bestR = r;
      }
    }
    // The C2D dash pattern covers roughly half the circumference; anything
    // below 0.18 is ground clutter, not a ring.
    if (bestF >= 0.18) {
      // Refine to 1px around the coarse peak.
      for (const r of [bestR - 1, bestR + 1]) {
        const f = ringWhiteFraction(image, s.cx, s.cy, r);
        if (f > bestF) {
          bestF = f;
          bestR = r;
        }
      }
      radii.push(bestR);
    }
  }
  if (radii.length < 3) return null;
  radii.sort((a, b) => a - b);
  const median = radii[Math.floor(radii.length / 2)];
  return {
    geoScale: C2D_RING_RADIUS_DEV_PX / median,
    ringRadiusPx: median,
    perBasketRadiiPx: radii
  };
}

/**
 * Area-average downscale to the geometry frame. Exact box averaging over
 * source pixel coverage — for geoScale 0.5 this is the 2x2 mean (identical
 * to OpenCV INTER_AREA at integer factors, which the dual-scale parity runs
 * used). geoScale within 2% of 1 returns the input untouched.
 */
export function resampleToGeometryFrame(image: RgbaImage, geoScale: number): RgbaImage {
  if (Math.abs(geoScale - 1) < 0.02) return image;
  const outW = Math.max(1, Math.round(image.width * geoScale));
  const outH = Math.max(1, Math.round(image.height * geoScale));
  const inv = 1 / geoScale;
  const out = new Uint8Array(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = oy * inv;
    const sy1 = Math.min(image.height, (oy + 1) * inv);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = ox * inv;
      const sx1 = Math.min(image.width, (ox + 1) * inv);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let y = Math.floor(sy0); y < sy1; y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        for (let x = Math.floor(sx0); x < sx1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const p = (y * image.width + x) * 4;
          r += image.data[p] * wgt;
          g += image.data[p + 1] * wgt;
          b += image.data[p + 2] * wgt;
          a += image.data[p + 3] * wgt;
          weight += wgt;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = Math.round(r / weight);
      out[o + 1] = Math.round(g / weight);
      out[o + 2] = Math.round(b / weight);
      out[o + 3] = Math.round(a / weight);
    }
  }
  return { width: outW, height: outH, data: out };
}
