/**
 * OpenCV-compatible chamfer distance transforms and the canonical-square
 * helpers the baseline builds on them.
 *
 * cv2.distanceTransform(src, DIST_L2, maskSize) with maskSize 3 or 5 is a
 * two-pass chamfer approximation with fixed float32 weights
 * (3x3: a=0.955, b=1.3693; 5x5: a=1, b=1.4, knight c=2.1969). Distances are
 * computed for nonzero pixels of src, to the nearest zero pixel. We keep the
 * arithmetic in Float32Array so accumulated weights round exactly like
 * OpenCV's float math.
 */

import { quantileF32Linear } from './npcompat';

export const MATCH_SIGMA = 1.75;
export const CANON_SIZE = 96;

const INIT = 1e15;

function chamferPass(
  dist: Float32Array,
  width: number,
  height: number,
  a: number,
  b: number,
  c: number | null,
): void {
  // Forward pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      let t = dist[i];
      if (t === 0) continue;
      if (x > 0) {
        const v = dist[i - 1] + a;
        if (v < t) t = v;
      }
      if (y > 0) {
        const up = i - width;
        {
          const v = dist[up] + a;
          if (v < t) t = v;
        }
        if (x > 0) {
          const v = dist[up - 1] + b;
          if (v < t) t = v;
        }
        if (x < width - 1) {
          const v = dist[up + 1] + b;
          if (v < t) t = v;
        }
        if (c !== null) {
          if (x > 1) {
            const v = dist[up - 2] + c;
            if (v < t) t = v;
          }
          if (x < width - 2) {
            const v = dist[up + 2] + c;
            if (v < t) t = v;
          }
        }
      }
      if (c !== null && y > 1) {
        const up2 = i - 2 * width;
        if (x > 0) {
          const v = dist[up2 - 1] + c;
          if (v < t) t = v;
        }
        if (x < width - 1) {
          const v = dist[up2 + 1] + c;
          if (v < t) t = v;
        }
      }
      dist[i] = t;
    }
  }
  // Backward pass.
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      let t = dist[i];
      if (t === 0) continue;
      if (x < width - 1) {
        const v = dist[i + 1] + a;
        if (v < t) t = v;
      }
      if (y < height - 1) {
        const down = i + width;
        {
          const v = dist[down] + a;
          if (v < t) t = v;
        }
        if (x < width - 1) {
          const v = dist[down + 1] + b;
          if (v < t) t = v;
        }
        if (x > 0) {
          const v = dist[down - 1] + b;
          if (v < t) t = v;
        }
        if (c !== null) {
          if (x < width - 2) {
            const v = dist[down + 2] + c;
            if (v < t) t = v;
          }
          if (x > 1) {
            const v = dist[down - 2] + c;
            if (v < t) t = v;
          }
        }
      }
      if (c !== null && y < height - 2) {
        const down2 = i + 2 * width;
        if (x < width - 1) {
          const v = dist[down2 + 1] + c;
          if (v < t) t = v;
        }
        if (x > 0) {
          const v = dist[down2 - 1] + c;
          if (v < t) t = v;
        }
      }
      dist[i] = t;
    }
  }
}

/**
 * cv2.distanceTransform(src, DIST_L2, 3): distance of each nonzero src pixel
 * to the nearest zero src pixel.
 */
export function distanceTransformL2Mask3(
  src: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = src[i] ? INIT : 0;
  chamferPass(dist, width, height, 0.955, 1.3693, null);
  return dist;
}

/** cv2.distanceTransform(src, DIST_L2, 5). */
export function distanceTransformL2Mask5(
  src: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = src[i] ? INIT : 0;
  chamferPass(dist, width, height, 1.0, 1.4, 2.1969);
  return dist;
}

/**
 * distance_to_foreground(mask): chamfer distance from every pixel to the
 * nearest foreground (nonzero) pixel of `mask` — i.e. the transform of the
 * inverted mask.
 */
export function distanceToForeground(
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  return distanceTransformL2Mask3(inv, width, height);
}

/** exp(-d^2 / (2 sigma^2)), rounded through float32 like the numpy pipeline. */
export function fuzzySupport(d: number): number {
  return Math.fround(Math.exp(Math.fround(-(d * d) / (2 * MATCH_SIGMA * MATCH_SIGMA))));
}

/** Integer-shift a CANON_SIZE mask with zero fill (warpAffine INTER_NEAREST). */
export function shiftMask(mask: Uint8Array, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(CANON_SIZE * CANON_SIZE);
  for (let y = 0; y < CANON_SIZE; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= CANON_SIZE) continue;
    for (let x = 0; x < CANON_SIZE; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= CANON_SIZE) continue;
      out[y * CANON_SIZE + x] = mask[sy * CANON_SIZE + sx];
    }
  }
  return out;
}

/**
 * inner_core(mask, keep_fraction): keep only foreground pixels whose 5x5
 * chamfer inside-distance is >= the (1 - keep_fraction) quantile
 * (np.quantile linear semantics on the float32 distances).
 */
export function innerCore(mask: Uint8Array, keepFraction: number): Uint8Array {
  if (keepFraction >= 0.999) return mask.slice();
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  if (count === 0) return mask.slice();
  const inside = distanceTransformL2Mask5(mask, CANON_SIZE, CANON_SIZE);
  const values = new Float32Array(count);
  let k = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) values[k++] = inside[i];
  values.sort();
  const cutoff = quantileF32Linear(values, 1.0 - keepFraction);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && inside[i] >= cutoff) out[i] = 1;
  }
  return out;
}
