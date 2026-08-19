/**
 * Feature extractors for NuThing P2 digit-recognition experiments.
 *
 * All extractors are pure functions over a normalized DIGIT_W x DIGIT_H
 * (24x32) binary mask (see `normalize.ts` — one byte per pixel, 0/1,
 * row-major). Browser-portable and dependency-free (no Node built-ins), so
 * the same code can run in `scripts/nuthing/train-prototype.ts` under tsx
 * and, later, in the annotate/recognize UI.
 *
 * Underlying hypothesis under study (see docs/nuthing-p2/prototype-classifier.md):
 * a digit is largely recognizable from *where* its bright (stroke) pixels
 * occur — i.e. from coarse spatial occupancy rather than the raw pixel
 * grid — so this module offers a family of extractors at different spatial
 * resolutions (whole-mask, coarse grid, finer grid, multiscale, 1-D
 * projections) plus a couple of shape descriptors (hole topology, stroke
 * density) for comparison.
 *
 * Every extractor returns a plain `number[]` so it can be JSON-serialized,
 * averaged into a prototype vector, and diffed/cosine-compared with no
 * dependency on the mask type itself.
 */

import { DIGIT_W, DIGIT_H, type NormalizedDigit } from './normalize';

/**
 * The full 24x32 mask as a flat 0/1 vector (768 dims), row-major, unchanged
 * from the input. This is the "no compression" baseline the compact
 * occupancy-grid features are compared against.
 */
export function fullMask768(mask: NormalizedDigit | ArrayLike<number>): number[] {
  const out = new Array<number>(DIGIT_W * DIGIT_H);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 1 : 0;
  return out;
}

/**
 * Generic occupancy grid: partitions the DIGIT_W x DIGIT_H mask into
 * `cols` x `rows` cells using an EVEN PIXEL PARTITION (cell boundaries are
 * `Math.round(i * DIGIT_W / cols)` / `Math.round(j * DIGIT_H / rows)`, so
 * cells differ in size by at most one pixel when the dimension does not
 * divide evenly — this is how occupancy8x10's 3x3.2px cells are realized:
 * row-cell heights alternate 3/3/3/4/3/3/3/4/3/3, no cell fixed at a
 * fractional size). Each cell's value is the fraction of its pixels that
 * are set (0..1). Output is row-major, `cols * rows` dims.
 */
export function occupancyGrid(
  mask: NormalizedDigit | ArrayLike<number>,
  cols: number,
  rows: number,
): number[] {
  const out = new Array<number>(cols * rows).fill(0);
  const colBound = (i: number): number => Math.round((i * DIGIT_W) / cols);
  const rowBound = (j: number): number => Math.round((j * DIGIT_H) / rows);
  for (let j = 0; j < rows; j++) {
    const y0 = rowBound(j);
    const y1 = rowBound(j + 1);
    for (let i = 0; i < cols; i++) {
      const x0 = colBound(i);
      const x1 = colBound(i + 1);
      const area = (x1 - x0) * (y1 - y0);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * DIGIT_W;
        for (let x = x0; x < x1; x++) sum += mask[row + x] ? 1 : 0;
      }
      out[j * cols + i] = area > 0 ? sum / area : 0;
    }
  }
  return out;
}

/**
 * 6 cols x 8 rows occupancy grid: exact 4x4px cells (24/6=4, 32/8=4, both
 * divide evenly). 48 dims.
 */
export function occupancy6x8(mask: NormalizedDigit | ArrayLike<number>): number[] {
  return occupancyGrid(mask, 6, 8);
}

/**
 * 8 cols x 10 rows occupancy grid: cell size 24/8=3px exact columns, and
 * 32/10=3.2px rows realized by the even pixel partition in `occupancyGrid`
 * (row-cell heights are 3,3,3,3,3,3,3,3,3,5 — Math.round of the boundary
 * sequence 0,3.2,6.4,9.6,12.8,16,19.2,22.4,25.6,28.8,32 gives boundaries
 * 0,3,6,10,13,16,19,22,26,29,32, i.e. row heights 3,3,4,3,3,3,3,4,3,3). 80
 * dims.
 */
export function occupancy8x10(mask: NormalizedDigit | ArrayLike<number>): number[] {
  return occupancyGrid(mask, 8, 10);
}

/** 12 cols x 16 rows occupancy grid: exact 2x2px cells. 192 dims. */
export function occupancy12x16(mask: NormalizedDigit | ArrayLike<number>): number[] {
  return occupancyGrid(mask, 12, 16);
}

/**
 * Multiscale occupancy: coarse 6x8 grid concatenated with finer 12x16 grid
 * (48 + 192 = 240 dims). Lets the prototype classifier use both a coarse
 * "where is the ink" signal and a somewhat finer one without going all the
 * way to the full 768-pixel mask.
 */
export function multiscale(mask: NormalizedDigit | ArrayLike<number>): number[] {
  return occupancy6x8(mask).concat(occupancy12x16(mask));
}

/**
 * Row projection: for each of the 32 rows, the fraction of that row's 24
 * pixels that are set (0..1). 32 dims.
 */
export function rowProjection32(mask: NormalizedDigit | ArrayLike<number>): number[] {
  const out = new Array<number>(DIGIT_H).fill(0);
  for (let y = 0; y < DIGIT_H; y++) {
    let sum = 0;
    const row = y * DIGIT_W;
    for (let x = 0; x < DIGIT_W; x++) sum += mask[row + x] ? 1 : 0;
    out[y] = sum / DIGIT_W;
  }
  return out;
}

/**
 * Column projection: for each of the 24 columns, the fraction of that
 * column's 32 pixels that are set (0..1). 24 dims.
 */
export function colProjection24(mask: NormalizedDigit | ArrayLike<number>): number[] {
  const out = new Array<number>(DIGIT_W).fill(0);
  for (let x = 0; x < DIGIT_W; x++) {
    let sum = 0;
    for (let y = 0; y < DIGIT_H; y++) sum += mask[y * DIGIT_W + x] ? 1 : 0;
    out[x] = sum / DIGIT_H;
  }
  return out;
}

/**
 * Aspect ratio of the digit's RAW (pre-normalization) crop, width/height.
 * Kept as a standalone helper rather than folded into an extractor because
 * every extractor above is pure over the mask alone (masks from the shared
 * dataset already carry rawWidth/rawHeight alongside them) — callers that
 * want aspect as part of a feature vector can concatenate
 * `[aspect(rawWidth, rawHeight)]` themselves.
 */
export function aspect(rawWidth: number, rawHeight: number): number {
  return rawHeight > 0 ? rawWidth / rawHeight : 0;
}

export interface TopologyFeatures {
  /** Count of background regions fully enclosed by stroke pixels (not touching the mask border). */
  holeCount: number;
  /** Each enclosed region's pixel count as a fraction of total mask pixels (768), holeCount entries, largest first. */
  holeSizeFractions: number[];
  /** Fraction of the 768 mask pixels that are set (stroke density). */
  strokeFraction: number;
}

/**
 * Topology descriptor via 4-connected flood fill of BACKGROUND (0) pixels
 * starting from every mask-border cell. Any 0-pixel reachable from the
 * border is "outside"; any 0-region never reached is an enclosed hole
 * (e.g. the loop of a 0/6/9, or either loop of an 8). This distinguishes
 * digits by stroke topology, independent of exact pixel placement:
 * 0/6/8/9 usually have 1 hole (8 has 2), 1/2/3/4/5/7 usually have 0
 * (a 4's counter is normally open to the mask border in this font/crop,
 * so it does not reliably form an enclosed hole — treated as a soft
 * signal, not a hard rule).
 *
 * Returns holeCount, each hole's size as a fraction of the 768-pixel mask
 * (sorted largest first, so index 0 is comparable across samples even when
 * hole count differs), and overall strokeFraction (set-pixel density).
 */
export function topology(mask: NormalizedDigit | ArrayLike<number>): TopologyFeatures {
  const n = DIGIT_W * DIGIT_H;
  const visited = new Uint8Array(n);
  const outside = new Uint8Array(n);

  // BFS flood fill of background pixels reachable from the border.
  const queue: number[] = [];
  for (let x = 0; x < DIGIT_W; x++) {
    for (const y of [0, DIGIT_H - 1]) {
      const idx = y * DIGIT_W + x;
      if (!mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        outside[idx] = 1;
        queue.push(idx);
      }
    }
  }
  for (let y = 0; y < DIGIT_H; y++) {
    for (const x of [0, DIGIT_W - 1]) {
      const idx = y * DIGIT_W + x;
      if (!mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        outside[idx] = 1;
        queue.push(idx);
      }
    }
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % DIGIT_W;
    const y = (idx - x) / DIGIT_W;
    const neighbors: [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= DIGIT_W || ny < 0 || ny >= DIGIT_H) continue;
      const nIdx = ny * DIGIT_W + nx;
      if (!mask[nIdx] && !visited[nIdx]) {
        visited[nIdx] = 1;
        outside[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  // Any remaining unvisited background pixel is part of an enclosed hole.
  // Flood-fill each such region (4-connected) to count holes and their sizes.
  const holeSizes: number[] = [];
  let strokeCount = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      strokeCount++;
      continue;
    }
    if (visited[i]) continue; // reachable from border, not a hole
    // New hole region: flood fill it.
    let size = 0;
    const q: number[] = [i];
    visited[i] = 1;
    while (q.length > 0) {
      const idx = q.pop()!;
      size++;
      const x = idx % DIGIT_W;
      const y = (idx - x) / DIGIT_W;
      const neighbors: [number, number][] = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= DIGIT_W || ny < 0 || ny >= DIGIT_H) continue;
        const nIdx = ny * DIGIT_W + nx;
        if (!mask[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          q.push(nIdx);
        }
      }
    }
    holeSizes.push(size);
  }
  holeSizes.sort((a, b) => b - a);

  return {
    holeCount: holeSizes.length,
    holeSizeFractions: holeSizes.map((s) => s / n),
    strokeFraction: strokeCount / n,
  };
}

/** Named registry of the vector-returning extractors, for the experiment driver. */
export const FEATURE_EXTRACTORS: Record<string, (mask: NormalizedDigit | ArrayLike<number>) => number[]> = {
  fullMask768,
  occupancy6x8,
  occupancy8x10,
  multiscale,
  rowProjection32,
  colProjection24,
};

/** Dimensionality of each registered extractor's output, without evaluating a mask. */
export const FEATURE_DIMS: Record<string, number> = {
  fullMask768: DIGIT_W * DIGIT_H,
  occupancy6x8: 6 * 8,
  occupancy8x10: 8 * 10,
  multiscale: 6 * 8 + 12 * 16,
  rowProjection32: DIGIT_H,
  colProjection24: DIGIT_W,
};
