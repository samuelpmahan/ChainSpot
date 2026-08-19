/**
 * Middle-out ribbon endpoint discovery (NuThing P1.5, experimental).
 *
 * Pure-TS port of the paired-edge ribbon evidence from
 * scripts/cv-probes/middleout/middleout.py (paired_bandness / support_cost),
 * extended with badge-seeded *endpoint discovery*: instead of routing
 * between already-known endpoints, a geodesic flood grows outward from each
 * badge (the one landmark P1 localizes reliably, and the validated path
 * midpoint of its hole), and the ribbon's termini emerge as local maxima of
 * geodesic distance. Termini form a ranked CandidatePool per badge — the
 * same broad-candidate primitive as the tee pool, so the two-pass
 * CULLED/FULL REPLAY protocol applies unchanged.
 *
 * Unlike the P1 port this module has no bit-parity contract; it is measured
 * against registered annotation truth (docs/nuthing-p2/annotation-registration.md).
 */

import type { RgbaImage } from './raster';
import type { ComponentStats } from './components';
import { CandidatePool } from './candidatePool';

export interface SupportField {
  width: number;
  height: number;
  /** Source pixels per field pixel. */
  scale: number;
  /** Normalized [0,1] paired-edge ribbon evidence. */
  support: Float32Array;
}

export interface RibbonOptions {
  scale?: number;
  widthsSrc?: number[];
  orientations?: number;
}

/** Default grid trades a little evidence sharpness for speed (the Python
 * probe used scale 3, 12 orientations, 6 widths); validated against the
 * registered dev truth gate. */
const DEFAULT_WIDTHS_SRC = [24, 36, 48, 60];
const DEFAULT_ORIENTATIONS = 8;
const DEFAULT_SCALE = 4;
const GAUSSIAN_SIGMA = 0.8;

/** Area-average downsample of RGB (alpha ignored) into float32 planes. */
function areaResizeRgb(
  image: RgbaImage,
  ew: number,
  eh: number,
): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(ew * eh * 3);
  const sx = width / ew;
  const sy = height / eh;
  for (let y = 0; y < eh; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(height, Math.ceil(y1));
    for (let x = 0; x < ew; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(width, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        const row = yy * width;
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          const w = wy * wx;
          const p = (row + xx) * 4;
          r += data[p] * w;
          g += data[p + 1] * w;
          b += data[p + 2] * w;
          wsum += w;
        }
      }
      const o = (y * ew + x) * 3;
      out[o] = r / wsum;
      out[o + 1] = g / wsum;
      out[o + 2] = b / wsum;
    }
  }
  return out;
}

/** Separable gaussian blur on interleaved RGB planes, reflect border. */
function gaussianBlurRgb(img: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.round(4 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const tmp = new Float32Array(img.length);
  const out = new Float32Array(img.length);
  const reflect = (i: number, n: number): number => {
    if (i < 0) return -i;
    if (i >= n) return 2 * n - 2 - i;
    return i;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = reflect(x + k, w);
        const p = (y * w + xx) * 3;
        const kv = kernel[k + radius];
        r += img[p] * kv;
        g += img[p + 1] * kv;
        b += img[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = reflect(y + k, h);
        const p = (yy * w + x) * 3;
        const kv = kernel[k + radius];
        r += tmp[p] * kv;
        g += tmp[p + 1] * kv;
        b += tmp[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/**
 * Whole-plane bilinear shift by a constant vector with reflect-101 border.
 * The fractional offsets are constant, so the four bilinear weights are
 * fixed for every pixel: the interior is a tight 4-tap loop; only a border
 * band the size of the shift needs reflected addressing.
 */
function shiftPlane(
  img: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
  out: Float32Array,
): void {
  const ix = Math.floor(dx);
  const iy = Math.floor(dy);
  const ax = dx - ix;
  const ay = dy - iy;
  const w00 = (1 - ax) * (1 - ay);
  const w01 = ax * (1 - ay);
  const w10 = (1 - ax) * ay;
  const w11 = ax * ay;
  const reflect = (i: number, n: number): number => {
    if (i < 0) return -i;
    if (i >= n) return 2 * n - 2 - i;
    return i;
  };
  // Interior bounds where x+ix, x+ix+1, y+iy, y+iy+1 are all in range.
  const xLo = Math.max(0, -ix);
  const xHi = Math.min(w, w - ix - 1);
  const yLo = Math.max(0, -iy);
  const yHi = Math.min(h, h - iy - 1);
  for (let y = 0; y < h; y++) {
    const interiorRow = y >= yLo && y < yHi;
    const rowOut = y * w * 3;
    if (interiorRow) {
      const r0 = (y + iy) * w * 3;
      const r1 = r0 + w * 3;
      let x = xLo;
      let o = rowOut + xLo * 3;
      let p0 = r0 + (xLo + ix) * 3;
      let p1 = r1 + (xLo + ix) * 3;
      for (; x < xHi; x++, o += 3, p0 += 3, p1 += 3) {
        out[o] = img[p0] * w00 + img[p0 + 3] * w01 + img[p1] * w10 + img[p1 + 3] * w11;
        out[o + 1] =
          img[p0 + 1] * w00 + img[p0 + 4] * w01 + img[p1 + 1] * w10 + img[p1 + 4] * w11;
        out[o + 2] =
          img[p0 + 2] * w00 + img[p0 + 5] * w01 + img[p1 + 2] * w10 + img[p1 + 5] * w11;
      }
      // Border columns of this row.
      for (let bx = 0; bx < w; bx++) {
        if (bx >= xLo && bx < xHi) {
          if (bx === xLo) bx = xHi - 1;
          continue;
        }
        const sx0 = reflect(bx + ix, w);
        const sx1 = reflect(bx + ix + 1, w);
        const sy0 = (y + iy) * w;
        const sy1 = (y + iy + 1) * w;
        const q00 = (sy0 + sx0) * 3;
        const q01 = (sy0 + sx1) * 3;
        const q10 = (sy1 + sx0) * 3;
        const q11 = (sy1 + sx1) * 3;
        const o = rowOut + bx * 3;
        for (let c = 0; c < 3; c++) {
          out[o + c] =
            img[q00 + c] * w00 + img[q01 + c] * w01 + img[q10 + c] * w10 + img[q11 + c] * w11;
        }
      }
    } else {
      const sy0 = reflect(y + iy, h) * w;
      const sy1 = reflect(y + iy + 1, h) * w;
      for (let bx = 0; bx < w; bx++) {
        const sx0 = reflect(bx + ix, w);
        const sx1 = reflect(bx + ix + 1, w);
        const q00 = (sy0 + sx0) * 3;
        const q01 = (sy0 + sx1) * 3;
        const q10 = (sy1 + sx0) * 3;
        const q11 = (sy1 + sx1) * 3;
        const o = rowOut + bx * 3;
        for (let c = 0; c < 3; c++) {
          out[o + c] =
            img[q00 + c] * w00 + img[q01 + c] * w01 + img[q10 + c] * w10 + img[q11 + c] * w11;
        }
      }
    }
  }
}

/**
 * Continuous paired-edge ribbon evidence field (paired_bandness port).
 * A pixel scores when two roughly parallel edges a plausible ribbon width
 * apart show matching RGB transitions — relative evidence, no color prior.
 */
export function computeRibbonSupport(image: RgbaImage, options: RibbonOptions = {}): SupportField {
  const scale = options.scale ?? DEFAULT_SCALE;
  const widthsSrc = options.widthsSrc ?? DEFAULT_WIDTHS_SRC;
  const orientations = options.orientations ?? DEFAULT_ORIENTATIONS;
  const ew = Math.floor(image.width / scale);
  const eh = Math.floor(image.height / scale);
  const small = gaussianBlurRgb(areaResizeRgb(image, ew, eh), ew, eh, GAUSSIAN_SIGMA);

  const delta = Math.max(1, 4 / scale);
  const n = ew * eh;
  const best = new Float32Array(n);
  const planeA = new Float32Array(n * 3);
  const planeB = new Float32Array(n * 3);
  const planeC = new Float32Array(n * 3);
  const planeD = new Float32Array(n * 3);

  for (let o = 0; o < orientations; o++) {
    const theta = (Math.PI * o) / orientations;
    const nx = -Math.sin(theta);
    const ny = Math.cos(theta);
    for (const widthSrc of widthsSrc) {
      const r = widthSrc / (2 * scale);
      shiftPlane(small, ew, eh, -nx * (r - delta), -ny * (r - delta), planeA);
      shiftPlane(small, ew, eh, -nx * (r + delta), -ny * (r + delta), planeB);
      shiftPlane(small, ew, eh, nx * (r - delta), ny * (r - delta), planeC);
      shiftPlane(small, ew, eh, nx * (r + delta), ny * (r + delta), planeD);
      for (let i = 0, p = 0; i < n; i++, p += 3) {
        const d1r = planeA[p] - planeB[p];
        const d1g = planeA[p + 1] - planeB[p + 1];
        const d1b = planeA[p + 2] - planeB[p + 2];
        const d2r = planeC[p] - planeD[p];
        const d2g = planeC[p + 1] - planeD[p + 1];
        const d2b = planeC[p + 2] - planeD[p + 2];
        const n1sq = d1r * d1r + d1g * d1g + d1b * d1b;
        const n2sq = d2r * d2r + d2g * d2g + d2b * d2b;
        const dot = d1r * d2r + d1g * d2g + d1b * d2b;
        if (dot <= 0) continue;
        const n1 = Math.sqrt(n1sq);
        const n2 = Math.sqrt(n2sq);
        let cosine = dot / (n1 * n2 + 1e-6);
        if (cosine > 1) cosine = 1;
        const score = (n1 < n2 ? n1 : n2) * cosine;
        if (score > best[i]) best[i] = score;
      }
    }
  }

  // Normalize by the 99.5th percentile of nonzero values, gamma 0.7.
  const nonzero: number[] = [];
  for (let i = 0; i < best.length; i++) if (best[i] > 0) nonzero.push(best[i]);
  nonzero.sort((a, b) => a - b);
  const p995 =
    nonzero.length > 0 ? nonzero[Math.min(nonzero.length - 1, Math.floor(0.995 * (nonzero.length - 1)))] : 1;
  const norm = Math.max(p995, 1e-6);
  const support = new Float32Array(best.length);
  for (let i = 0; i < best.length; i++) {
    let v = best[i] / norm;
    if (v > 1) v = 1;
    support[i] = Math.pow(v, 0.7);
  }
  return { width: ew, height: eh, scale, support };
}

/**
 * Cost surface: 1 + 4 (1 - support)^2, with a containment boost for
 * near-zero support (the probe's cost tops out at 5, which lets a geodesic
 * flood wander far across textured basemap; boosting the truly unsupported
 * floor keeps the flood on and near ribbons without affecting on-ribbon
 * routing).
 */
export function supportCost(field: SupportField, lowSupportBoost = 10, lowSupport = 0.12): Float32Array {
  const cost = new Float32Array(field.support.length);
  for (let i = 0; i < cost.length; i++) {
    const s = field.support[i];
    const u = 1 - s;
    cost[i] = s < lowSupport ? lowSupportBoost : 1 + 4 * u * u;
  }
  return cost;
}

export interface RibbonEndpoint {
  /** Source-image coordinates of the terminus. */
  x: number;
  y: number;
  /** Geodesic cost from the badge seed. */
  geodesic: number;
  /** Euclidean source-px distance from the badge center. */
  radius: number;
  /** Mean support along the backtracked path. */
  meanSupport: number;
  /** Path length in source px. */
  pathLen: number;
}

export interface BadgeEndpointDiscovery {
  endpoints: CandidatePool<RibbonEndpoint>;
}

export interface EndpointDiscoveryOptions {
  /** Geodesic budget (cost x field px). */
  maxGeodesic?: number;
  /** Seed disk radius (field px) with cost clamped, as in route_leg. */
  seedRadius?: number;
  seedCostClamp?: number;
  /** Minimum support for a terminus pixel. */
  minTerminusSupport?: number;
  /** Non-maximum suppression radius between termini (field px). */
  nmsRadius?: number;
  /** Theoretical floor for the endpoint pool (on meanSupport). */
  theoreticalFloor?: number;
  /** primaryCount for the pool (2 = one tee end + one basket end). */
  primaryCount?: number;
  maxCandidates?: number;
}


interface FloodResult {
  dist: Float64Array;
  prev: Int32Array;
  x0: number;
  y0: number;
  rw: number;
  rh: number;
  /** Seed position in field coordinates. */
  sx: number;
  sy: number;
}

/** Geodesic flood (dial-style bucket Dijkstra) from a source-space seed. */
function floodFromSeed(
  field: SupportField,
  cost: Float32Array,
  seedXSrc: number,
  seedYSrc: number,
  maxGeodesic: number,
  seedRadius: number,
  seedCostClamp: number,
): FloodResult {
  const { width: w, height: h, scale } = field;
  const sx = seedXSrc / scale;
  const sy = seedYSrc / scale;
  const cxI = Math.round(sx);
  const cyI = Math.round(sy);
  const roiR = Math.ceil(maxGeodesic) + seedRadius + 2;
  const x0 = Math.max(0, cxI - roiR);
  const x1 = Math.min(w - 1, cxI + roiR);
  const y0 = Math.max(0, cyI - roiR);
  const y1 = Math.min(h - 1, cyI + roiR);
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const dist = new Float64Array(rw * rh).fill(Infinity);
  const prev = new Int32Array(rw * rh).fill(-1);
  const roiCost = new Float32Array(rw * rh);
  for (let ly = 0; ly < rh; ly++) {
    const gy = y0 + ly;
    for (let lx = 0; lx < rw; lx++) {
      const gx = x0 + lx;
      let c = cost[gy * w + gx];
      const ddx = gx - sx;
      const ddy = gy - sy;
      if (ddx * ddx + ddy * ddy <= seedRadius * seedRadius && c > seedCostClamp) {
        c = seedCostClamp;
      }
      roiCost[ly * rw + lx] = c;
    }
  }
  const QUANTUM = 0.25;
  const bucketCount = Math.ceil(maxGeodesic / QUANTUM) + 2;
  const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
  const startIdx = (cyI - y0) * rw + (cxI - x0);
  dist[startIdx] = 0;
  buckets[0].push(startIdx);
  const NOFF = [-rw - 1, -rw, -rw + 1, -1, 1, rw - 1, rw, rw + 1];
  const STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
  for (let bkt = 0; bkt < bucketCount; bkt++) {
    const queue = buckets[bkt];
    for (let qi = 0; qi < queue.length; qi++) {
      const curIdx = queue[qi];
      const curDist = dist[curIdx];
      if (Math.floor(curDist / QUANTUM) !== bkt) continue; // stale entry
      const lx = curIdx % rw;
      const onLeftEdge = lx === 0;
      const onRightEdge = lx === rw - 1;
      const cHere = roiCost[curIdx];
      for (let k = 0; k < 8; k++) {
        if (onLeftEdge && (k === 0 || k === 3 || k === 5)) continue;
        if (onRightEdge && (k === 2 || k === 4 || k === 7)) continue;
        const ni = curIdx + NOFF[k];
        if (ni < 0 || ni >= dist.length) continue;
        const nd = curDist + ((cHere + roiCost[ni]) / 2) * STEP[k];
        if (nd < dist[ni] && nd <= maxGeodesic) {
          dist[ni] = nd;
          prev[ni] = curIdx;
          buckets[Math.floor(nd / QUANTUM)].push(ni);
        }
      }
    }
    buckets[bkt] = [];
  }
  return { dist, prev, x0, y0, rw, rh, sx, sy };
}

/**
 * Geodesic flood from a badge center over the ribbon cost surface; termini
 * (local maxima of geodesic distance on supported pixels) become a ranked
 * endpoint pool. Ranking score = meanSupport x sqrt(pathLen): long,
 * well-supported legs first; the observed cardinality prior is 2 (a badge
 * sits mid-path with a tee end and a basket end).
 */
export function discoverBadgeEndpoints(
  field: SupportField,
  cost: Float32Array,
  badgeCxSrc: number,
  badgeCySrc: number,
  options: EndpointDiscoveryOptions = {},
): BadgeEndpointDiscovery {
  const {
    maxGeodesic = 420,
    seedRadius = 5,
    seedCostClamp = 1.4,
    minTerminusSupport = 0.2,
    nmsRadius = 5,
    theoreticalFloor = 0.4,
    primaryCount = 2,
    maxCandidates = 48,
  } = options;
  const { width: w, scale, support } = field;
  const { dist, prev, x0, y0, rw, rh, sx, sy } = floodFromSeed(
    field,
    cost,
    badgeCxSrc,
    badgeCySrc,
    maxGeodesic,
    seedRadius,
    seedCostClamp,
  );

  // Termini: local maxima of geodesic distance among reached, supported px.
  const candidates: { idx: number; d: number }[] = [];
  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const i = ly * rw + lx;
      const d = dist[i];
      if (!Number.isFinite(d) || d > maxGeodesic || d < 8) continue;
      if (support[(y0 + ly) * w + (x0 + lx)] < minTerminusSupport) continue;
      let isMax = true;
      for (let ky = -1; ky <= 1 && isMax; ky++) {
        const ny2 = ly + ky;
        if (ny2 < 0 || ny2 >= rh) continue;
        for (let kx = -1; kx <= 1; kx++) {
          if (kx === 0 && ky === 0) continue;
          const nx2 = lx + kx;
          if (nx2 < 0 || nx2 >= rw) continue;
          const nd = dist[ny2 * rw + nx2];
          if (Number.isFinite(nd) && nd <= maxGeodesic && nd > d) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ idx: i, d });
    }
  }
  // Terminus quality: prefilter by geodesic/euclidean efficiency (on-ribbon
  // paths cost ~1.2-2.2 per px; anything that had to cross the boosted
  // off-ribbon floor is much less efficient), then score survivors by mean
  // support along their backtracked path. Selecting by raw geodesic
  // distance would fill the pool with budget-frontier plateau maxima.
  const MAX_EFFICIENCY = 3.0;
  const prefiltered: { idx: number; d: number; eff: number }[] = [];
  for (const cand of candidates) {
    const lx = cand.idx % rw;
    const ly = (cand.idx / rw) | 0;
    const eu = Math.hypot(x0 + lx - sx, y0 + ly - sy);
    if (eu < 10) continue;
    const eff = cand.d / eu;
    if (eff <= MAX_EFFICIENCY) prefiltered.push({ idx: cand.idx, d: cand.d, eff });
  }

  const scored: RibbonEndpoint[] = [];
  for (const cand of prefiltered) {
    // Backtrack path, accumulate support.
    let i = cand.idx;
    let supSum = 0;
    let steps = 0;
    let guard = 0;
    while (i >= 0 && guard++ < rw * rh) {
      const plx = i % rw;
      const ply = (i / rw) | 0;
      supSum += support[(y0 + ply) * w + (x0 + plx)];
      steps++;
      i = prev[i];
    }
    const meanSupport = steps > 0 ? supSum / steps : 0;
    const lx = cand.idx % rw;
    const ly = (cand.idx / rw) | 0;
    const gx = (x0 + lx) * scale;
    const gy = (y0 + ly) * scale;
    scored.push({
      x: gx,
      y: gy,
      geodesic: cand.d,
      radius: Math.hypot(gx - badgeCxSrc, gy - badgeCySrc),
      meanSupport,
      pathLen: steps * scale,
    });
  }
  // Farthest-first among efficient candidates: with the boosted off-ribbon
  // floor, distance is only attainable along ribbons, so the leg ends (tee,
  // basket) come first; mid-ribbon local maxima enter later and crossing
  // continuations later still.
  scored.sort((a, b) => b.geodesic - a.geodesic);

  // NMS in quality order.
  const chosen: RibbonEndpoint[] = [];
  const nmsSrc = nmsRadius * scale;
  for (const cand of scored) {
    if (chosen.length >= maxCandidates) break;
    let suppressed = false;
    for (const t of chosen) {
      const ddx = t.x - cand.x;
      const ddy = t.y - cand.y;
      if (ddx * ddx + ddy * ddy <= nmsSrc * nmsSrc) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) chosen.push(cand);
  }
  const pool = new CandidatePool(
    chosen.map((e) => ({ value: e, score: e.meanSupport })),
    { primaryCount, theoreticalFloor, preRanked: true },
  );
  return { endpoints: pool };
}

export interface EndpointComponentCandidate {
  /** Bright component at the endpoint, or null for a virtual boundary
   * terminus (ribbon runs off the capture edge; the icon is clipped away). */
  component: ComponentStats | null;
  /** Endpoint position in source px (component centroid, or terminus). */
  x: number;
  y: number;
  /** Min geodesic cost from the badge over the component's expanded bbox. */
  geodesic: number;
  /** Euclidean source-px distance from badge center to component centroid. */
  radius: number;
  /** geodesic / euclidean field distance — ~1-2.2 along ribbon. */
  efficiency: number;
  /** Render-identity classification (UDisc renders one fixed basket sprite
   * and one tee-rectangle style at this capture scale, like the badges). */
  kind: 'tee-rect' | 'basket-sprite' | 'other' | 'virtual';
  /** True when the backtracked flood path from the badge reaches this icon
   * without passing through any other icon: the hole's own endpoints are
   * the FIRST icon outward along each leg; anything beyond a crossing is
   * not. */
  firstIcon?: boolean;
  /** Source-px position where this candidate's flood path leaves the badge
   * vicinity — two endpoints on the same ribbon branch share it. */
  gateX?: number;
  gateY?: number;
}

export interface EndpointComponentOptions {
  maxGeodesic?: number;
  seedRadius?: number;
  seedCostClamp?: number;
  /** Expand each component bbox by this many field px when sampling the
   * flood (lets the flood "hand off" to an icon whose interior has no
   * ribbon-edge signal, e.g. a basket sprite inside its dashed circle). */
  snapMarginField?: number;
  maxEfficiency?: number;
  /** Ignore components closer than this to the badge (source px). */
  minRadiusSrc?: number;
  minArea?: number;
  maxArea?: number;
  primaryCount?: number;
  maxCandidates?: number;
}

/**
 * Middle-out endpoint discovery fused with the bright-component universe:
 * instead of reporting raw flood termini, score already-extracted bright
 * components (tee rectangles, basket sprites, ...) by ribbon reachability
 * from the badge. A hole's endpoints are the far, efficiently-reachable
 * components; ranking is farthest-first, primaryCount = 2 (tee + basket).
 */
export function scoreEndpointComponents(
  field: SupportField,
  cost: Float32Array,
  badgeCxSrc: number,
  badgeCySrc: number,
  components: ComponentStats[],
  options: EndpointComponentOptions = {},
): CandidatePool<EndpointComponentCandidate> {
  const {
    maxGeodesic = 700,
    seedRadius = 5,
    seedCostClamp = 1.4,
    snapMarginField = 4,
    maxEfficiency = 3.5,
    minRadiusSrc = 40,
    minArea = 12,
    maxArea = 6000,
    primaryCount = 2,
    maxCandidates = 64,
  } = options;
  const { scale } = field;
  const { dist, prev, x0, y0, rw, rh, sx, sy } = floodFromSeed(
    field,
    cost,
    badgeCxSrc,
    badgeCySrc,
    maxGeodesic,
    seedRadius,
    seedCostClamp,
  );

  const rows: EndpointComponentCandidate[] = [];
  const argmins: number[] = [];
  /** Ancestor pixel where each candidate's flood path last exceeded the gate
   * geodesic — two endpoints on the same ribbon branch share it. */
  const gates: number[] = [];
  for (const c of components) {
    if (c.area < minArea || c.area > maxArea) continue;
    const radius = Math.hypot(c.cx - badgeCxSrc, c.cy - badgeCySrc);
    if (radius < minRadiusSrc) continue;
    // Field-space expanded bbox intersected with the flood ROI.
    const bx0 = Math.max(0, Math.floor(c.bboxX / scale) - snapMarginField - x0);
    const bx1 = Math.min(rw - 1, Math.ceil((c.bboxX + c.bboxW) / scale) + snapMarginField - x0);
    const by0 = Math.max(0, Math.floor(c.bboxY / scale) - snapMarginField - y0);
    const by1 = Math.min(rh - 1, Math.ceil((c.bboxY + c.bboxH) / scale) + snapMarginField - y0);
    if (bx1 < bx0 || by1 < by0) continue;
    let g = Infinity;
    let argmin = -1;
    for (let ly = by0; ly <= by1; ly++) {
      const row = ly * rw;
      for (let lx = bx0; lx <= bx1; lx++) {
        const d = dist[row + lx];
        if (d < g) {
          g = d;
          argmin = row + lx;
        }
      }
    }
    if (!Number.isFinite(g) || g > maxGeodesic) continue;
    const euclidField = Math.max(1, Math.hypot(c.cx / scale - sx, c.cy / scale - sy));
    const efficiency = g / euclidField;
    if (efficiency > maxEfficiency) continue;
    const isBasket =
      c.bboxW >= 36 && c.bboxW <= 48 && c.bboxH >= 58 && c.bboxH <= 74 &&
      c.area >= 1300 && c.area <= 2100 && c.fill >= 0.45;
    const isTee =
      !isBasket &&
      c.bboxW >= 13 && c.bboxW <= 40 && c.bboxH >= 13 && c.bboxH <= 40 &&
      c.area >= 100 && c.area <= 320 && c.fill >= 0.2 && c.fill <= 0.65;
    rows.push({
      component: c,
      x: c.cx,
      y: c.cy,
      geodesic: g,
      radius,
      efficiency,
      kind: isBasket ? 'basket-sprite' : isTee ? 'tee-rect' : 'other',
    });
    argmins.push(argmin);
  }
  // Virtual boundary termini: when the ribbon runs off the capture edge the
  // endpoint icon may be clipped out of existence; the flood terminus at the
  // image boundary is then itself an endpoint candidate.
  {
    const { width: fw, height: fh } = field;
    const boundary: { lx: number; ly: number; d: number }[] = [];
    for (let ly = 0; ly < rh; ly++) {
      const gy = y0 + ly;
      const yEdge = gy <= 1 || gy >= fh - 2;
      for (let lx = 0; lx < rw; lx++) {
        const gx = x0 + lx;
        if (!yEdge && gx > 1 && gx < fw - 2) continue;
        const d = dist[ly * rw + lx];
        if (!Number.isFinite(d) || d > maxGeodesic || d < 20) continue;
        boundary.push({ lx, ly, d });
      }
    }
    boundary.sort((a, b) => b.d - a.d);
    const takenB: { lx: number; ly: number }[] = [];
    for (const b of boundary) {
      if (takenB.length >= 4) break;
      if (takenB.some((t) => (t.lx - b.lx) ** 2 + (t.ly - b.ly) ** 2 <= 100)) continue;
      takenB.push({ lx: b.lx, ly: b.ly });
      const gx = (x0 + b.lx) * scale;
      const gy = (y0 + b.ly) * scale;
      const radius = Math.hypot(gx - badgeCxSrc, gy - badgeCySrc);
      if (radius < minRadiusSrc) continue;
      const euclidField = Math.max(1, radius / scale);
      const efficiency = b.d / euclidField;
      if (efficiency > maxEfficiency) continue;
      rows.push({ component: null, x: gx, y: gy, geodesic: b.d, radius, efficiency, kind: 'virtual' });
      argmins.push(b.ly * rw + b.lx);
      // gate filled by the first-icon pass (kind 'virtual' participates).
    }
  }

  // First-icon analysis: paint each identity candidate's bbox into an ROI
  // grid, then walk every identity candidate's backtracked flood path; a
  // path that crosses another icon's bbox means this candidate lies beyond
  // a nearer icon (a crossing continuation), so it is not the hole's own
  // endpoint.
  {
    const iconGrid = new Int32Array(rw * rh).fill(-1);
    for (let ri = 0; ri < rows.length; ri++) {
      const c = rows[ri].component;
      if (!c || rows[ri].kind === 'other') continue;
      const bx0 = Math.max(0, Math.floor(c.bboxX / scale) - 1 - x0);
      const bx1 = Math.min(rw - 1, Math.ceil((c.bboxX + c.bboxW) / scale) + 1 - x0);
      const by0 = Math.max(0, Math.floor(c.bboxY / scale) - 1 - y0);
      const by1 = Math.min(rh - 1, Math.ceil((c.bboxY + c.bboxH) / scale) + 1 - y0);
      for (let ly = by0; ly <= by1; ly++) {
        for (let lx = bx0; lx <= bx1; lx++) iconGrid[ly * rw + lx] = ri;
      }
    }
    const GATE_GEO = 15;
    for (let ri = 0; ri < rows.length; ri++) {
      if (rows[ri].kind === 'other') continue;
      let i = argmins[ri];
      let passes = false;
      let guard = 0;
      let gate = argmins[ri];
      while (i >= 0 && guard++ < rw * rh) {
        const owner = iconGrid[i];
        if (owner !== -1 && owner !== ri) passes = true;
        if (dist[i] > GATE_GEO) gate = i;
        i = prev[i];
      }
      rows[ri].firstIcon = !passes;
      gates[ri] = gate;
      rows[ri].gateX = (x0 + (gate % rw)) * scale;
      rows[ri].gateY = (y0 + ((gate / rw) | 0)) * scale;
    }
  }

  // Middle-out pairing, identity-first: UDisc renders one fixed basket
  // sprite and one tee-rect style, so the true pair is (tee-rect,
  // basket-sprite) with near-equal along-ribbon geodesic distances (the
  // badge is the path midpoint). Tiers degrade gracefully when an icon is
  // occluded/merged: (tee,basket) > (any,basket) > (tee,any) > generic.
  // Badges are NOT reliably at the path midpoint (Heritage anchors them near
  // the tee), so no balance prior. The true pair is the geodesically nearest
  // (tee, basket) whose flood paths DIVERGE at the badge — the two legs
  // leave along different ribbon branches, checked via each candidate's
  // gate pixel (the path ancestor just beyond the seed vicinity).
  const pairCost = (i: number, j: number): number => rows[i].geodesic + rows[j].geodesic;
  const validPair = (i: number, j: number): boolean => {
    const a = rows[i];
    const b = rows[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 60) return false;
    const ga = gates[i];
    const gb = gates[j];
    if (ga === undefined || gb === undefined) return true;
    const gax = ga % rw;
    const gay = (ga / rw) | 0;
    const gbx = gb % rw;
    const gby = (gb / rw) | 0;
    const diverge = Math.hypot(gax - gbx, gay - gby) >= 4;
    // Tiny holes: both endpoints within the gate radius have trivial gates.
    return diverge || (a.geodesic <= 18 && b.geodesic <= 18);
  };
  const teeish = (c: EndpointComponentCandidate): boolean =>
    c.kind === 'tee-rect' || c.kind === 'virtual';
  const basketish = (c: EndpointComponentCandidate): boolean => c.kind === 'basket-sprite';
  const first = (c: EndpointComponentCandidate): boolean => c.firstIcon === true;
  const tiers: [(c: EndpointComponentCandidate) => boolean, (c: EndpointComponentCandidate) => boolean][] = [
    [(c) => teeish(c) && first(c), (c) => basketish(c) && first(c)],
    [(c) => teeish(c) && first(c), basketish],
    [teeish, (c) => basketish(c) && first(c)],
    [teeish, basketish],
    [() => true, basketish],
    [teeish, () => true],
    [() => true, () => true],
  ];
  let bestPair: [number, number] | null = null;
  let bestPairCost = Infinity;
  for (const [teeOk, basketOk] of tiers) {
    for (let i = 0; i < rows.length; i++) {
      if (!teeOk(rows[i])) continue;
      for (let j = 0; j < rows.length; j++) {
        if (i === j || !basketOk(rows[j])) continue;
        if (!validPair(i, j)) continue;
        const cost = pairCost(i, j);
        if (cost < bestPairCost) {
          bestPairCost = cost;
          bestPair = [i, j];
        }
      }
    }
    if (bestPair) break;
  }
  const ordered: EndpointComponentCandidate[] = [];
  if (bestPair) {
    ordered.push(rows[bestPair[0]], rows[bestPair[1]]);
  }
  const rest = rows
    .filter((_, i) => !bestPair || (i !== bestPair[0] && i !== bestPair[1]))
    .sort((a, b) => a.geodesic - b.geodesic);
  ordered.push(...rest);
  return new CandidatePool(
    ordered.slice(0, maxCandidates).map((r) => ({ value: r, score: -r.geodesic })),
    { primaryCount, theoreticalFloor: -Infinity, preRanked: true },
  );
}

export interface CourseEndpointAssignment {
  /** Per input badge index: assigned tee/basket candidates (null when none). */
  tee: (EndpointComponentCandidate | null)[];
  basket: (EndpointComponentCandidate | null)[];
}

/**
 * Course-level endpoint assignment. Per-badge nearest choices steal
 * neighboring holes' icons at ribbon crossings; globally, every tee/basket
 * icon belongs to exactly one hole and is geodesically nearest to its OWN
 * badge, so a greedy ascending-geodesic assignment with 1:1 uniqueness
 * resolves the theft. Baskets assign first (fixed sprite = strongest
 * identity); each badge's tee must then leave the badge along a different
 * ribbon branch than its basket (gate divergence).
 */
export function assignCourseEndpoints(
  pools: CandidatePool<EndpointComponentCandidate>[],
): CourseEndpointAssignment {
  const n = pools.length;
  const tee: (EndpointComponentCandidate | null)[] = new Array(n).fill(null);
  const basket: (EndpointComponentCandidate | null)[] = new Array(n).fill(null);
  const usedComponents = new Set<number>();

  interface Entry {
    badge: number;
    cand: EndpointComponentCandidate;
  }
  const collect = (kinds: Set<string>): Entry[] => {
    const entries: Entry[] = [];
    for (let b = 0; b < n; b++) {
      for (const c of pools[b].unculled) {
        if (kinds.has(c.value.kind)) entries.push({ badge: b, cand: c.value });
      }
    }
    entries.sort((p, q) => p.cand.geodesic - q.cand.geodesic);
    return entries;
  };

  // Round 1: only first-icon baskets (a basket reached THROUGH another icon
  // belongs to a different hole — e.g. badge N+1 reaching basket N through
  // tee N+1). Round 2 relaxes for badges left empty (occlusions).
  for (const requireFirst of [true, false]) {
    for (const e of collect(new Set(['basket-sprite']))) {
      if (requireFirst && e.cand.firstIcon !== true) continue;
      if (basket[e.badge]) continue;
      const label = e.cand.component?.label ?? -1;
      if (usedComponents.has(label)) continue;
      basket[e.badge] = e.cand;
      usedComponents.add(label);
    }
  }

  const diverges = (a: EndpointComponentCandidate, b: EndpointComponentCandidate): boolean => {
    if (
      a.gateX === undefined ||
      a.gateY === undefined ||
      b.gateX === undefined ||
      b.gateY === undefined
    ) {
      return true;
    }
    if (a.geodesic <= 18 && b.geodesic <= 18) return true;
    return Math.hypot(a.gateX - b.gateX, a.gateY - b.gateY) >= 16;
  };

  for (const requireFirst of [true, false]) {
    for (const e of collect(new Set(['tee-rect', 'virtual']))) {
      if (requireFirst && e.cand.firstIcon !== true) continue;
      if (tee[e.badge]) continue;
      const label = e.cand.component?.label ?? -1;
      if (label !== -1 && usedComponents.has(label)) continue;
      const myBasket = basket[e.badge];
      if (myBasket && !diverges(e.cand, myBasket)) continue;
      tee[e.badge] = e.cand;
      if (label !== -1) usedComponents.add(label);
    }
  }

  return { tee, basket };
}
