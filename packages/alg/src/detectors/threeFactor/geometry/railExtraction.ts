/** A visible pixel, in the SAME coordinate frame the caller passes in. */
export type Px = readonly [number, number];

/** A known occluder's footprint, same frame as the pixel set — a set of
 *  exact pixel coordinates (NOT a bbox: z-order means only some pixels
 *  under a bbox are actually occluded). */
export interface OccluderFootprint {
  readonly kind: 'badge' | 'basket' | 'c2-chrome' | 'screen-chrome';
  readonly pixels: ReadonlySet<string>; // `${x},${y}` keys
}

/** One candidate straight edge the fragment offers. */
export interface RailCandidate {
  readonly points: readonly Px[];
  readonly angleRad: number;            // rail's own line direction
  readonly lengthPx: number;            // span along the rail's own axis
  readonly straightnessScore: number;   // 0..1, 1 = perfectly collinear (RMS perpendicular deviation from best-fit line, normalized by lengthPx)
  readonly interruptionPx: number;      // total px of gap along the rail's span
  readonly qualityScore: number;        // HIGHER IS BETTER; monotonic increasing in lengthPx and straightnessScore, monotonic decreasing in interruptionPx; document the formula in one plain sentence
  readonly occludedFractionPx: number;  // fraction of this rail's span under any OccluderFootprint (0 = clean edge)
}

/** Minimum pixels required to estimate a line direction at raster quantization tolerance.
 *  Derived from raster geometry: with ±1.25px quantization noise per pixel, 4 pixels yield ~2-degree
 *  direction precision, sufficient to distinguish a true edge from noise in boundary fragments.
 */
const MIN_RAIL_PIXELS = 4;

/** Return every candidate straight rail the fragment offers, ranked
 *  best-first by qualityScore (ties: lowest occludedFractionPx, then
 *  longest lengthPx). [] when no straight-edge segment of at least
 *  MIN_RAIL_PIXELS survives. */
export function extractRailCandidates(
  pixels: readonly Px[],
  occluders: readonly OccluderFootprint[]
): readonly RailCandidate[] {
  if (pixels.length < MIN_RAIL_PIXELS) {
    return [];
  }

  // Build set of occluded pixel coordinates for fast lookup.
  const occludedSet = new Set<string>();
  for (const occluder of occluders) {
    for (const pixelKey of occluder.pixels) {
      occludedSet.add(pixelKey);
    }
  }

  // Compute boundary pixels (edge pixels with at least one non-filled neighbor).
  const pixelSet = new Set<string>();
  const pixelArray = Array.from(pixels);
  for (const [x, y] of pixelArray) {
    pixelSet.add(`${x},${y}`);
  }

  const boundaryPixels = extractBoundaryPixels(pixelArray, pixelSet);
  if (boundaryPixels.length < MIN_RAIL_PIXELS) {
    return [];
  }

  // Trace boundary as an ordered chain and detect corners to segment into runs.
  const chain = traceOrderedBoundaryChain(boundaryPixels);
  if (chain.length < MIN_RAIL_PIXELS) {
    return [];
  }

  // Find corner indices by detecting sharp direction changes in the chain.
  const cornerIndices = detectCornerIndices(chain);

  // Segment chain into runs at corners.
  const runs: Px[][] = [];
  let start = 0;

  for (const cornerIdx of cornerIndices) {
    if (cornerIdx - start >= MIN_RAIL_PIXELS) {
      runs.push(chain.slice(start, cornerIdx) as Px[]);
    }
    start = cornerIdx;
  }

  // Add final segment from last corner to chain end.
  if (chain.length - start >= MIN_RAIL_PIXELS) {
    runs.push(chain.slice(start) as Px[]);
  }

  // If no runs created, try whole chain.
  if (runs.length === 0 && chain.length >= MIN_RAIL_PIXELS) {
    runs.push(chain as Px[]);
  }

  // Fit line to each run to create rail candidates.
  const candidates: RailCandidate[] = [];
  for (const run of runs) {
    if (run.length >= MIN_RAIL_PIXELS) {
      const candidate = fitRailToRun(run, occludedSet);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  // Sort by qualityScore (descending), then occludedFractionPx (ascending), then lengthPx (descending).
  candidates.sort((a, b) => {
    if (Math.abs(a.qualityScore - b.qualityScore) > 1e-9) {
      return b.qualityScore - a.qualityScore;
    }
    if (Math.abs(a.occludedFractionPx - b.occludedFractionPx) > 1e-9) {
      return a.occludedFractionPx - b.occludedFractionPx;
    }
    return b.lengthPx - a.lengthPx;
  });

  return candidates;
}

/** Extract boundary pixels from the fragment: pixels with at least one non-filled neighbor in 8-connectivity. */
function extractBoundaryPixels(
  pixels: readonly Px[],
  pixelSet: Set<string>
): Px[] {
  const boundary: Px[] = [];

  for (const [x, y] of pixels) {
    // Check 8-connected neighbors.
    let hasMissingNeighbor = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (!pixelSet.has(`${x + dx},${y + dy}`)) {
          hasMissingNeighbor = true;
          break;
        }
      }
      if (hasMissingNeighbor) break;
    }

    if (hasMissingNeighbor) {
      boundary.push([x, y]);
    }
  }

  return boundary;
}


/** Trace boundary pixels into an ordered chain via 8-connectivity. */
function traceOrderedBoundaryChain(boundaryPixels: readonly Px[]): Px[] {
  if (boundaryPixels.length === 0) return [];

  // Sort pixels for determinism.
  const sorted = boundaryPixels
    .slice()
    .sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

  const chain: Px[] = [sorted[0]];
  const used = new Set<string>();
  used.add(`${sorted[0][0]},${sorted[0][1]}`);

  while (chain.length < boundaryPixels.length) {
    const current = chain[chain.length - 1];
    let nextPixel: Px | null = null;
    let bestDistance = Infinity;

    // Find nearest unvisited 8-neighbor for deterministic traversal.
    for (const pixel of sorted) {
      const key = `${pixel[0]},${pixel[1]}`;
      if (used.has(key)) continue;

      const dx = pixel[0] - current[0];
      const dy = pixel[1] - current[1];
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        const dist = dx * dx + dy * dy;
        if (dist < bestDistance) {
          bestDistance = dist;
          nextPixel = pixel;
        }
      }
    }

    if (!nextPixel) break;

    chain.push(nextPixel);
    used.add(`${nextPixel[0]},${nextPixel[1]}`);
  }

  return chain;
}

/** Detect corner indices in a boundary chain by finding sharp direction changes.
 *  A corner is where consecutive direction vectors change by more than ~60 degrees. */
function detectCornerIndices(chain: readonly Px[]): number[] {
  const corners: number[] = [];

  if (chain.length < 3) return corners;

  for (let i = 1; i < chain.length - 1; i++) {
    const prev = chain[i - 1];
    const curr = chain[i];
    const next = chain[i + 1];

    // Compute direction vectors.
    const dir1 = [curr[0] - prev[0], curr[1] - prev[1]];
    const dir2 = [next[0] - curr[0], next[1] - curr[1]];

    // Normalize.
    const len1 = Math.sqrt(dir1[0] * dir1[0] + dir1[1] * dir1[1]);
    const len2 = Math.sqrt(dir2[0] * dir2[0] + dir2[1] * dir2[1]);

    if (len1 < 1e-6 || len2 < 1e-6) continue;

    dir1[0] /= len1;
    dir1[1] /= len1;
    dir2[0] /= len2;
    dir2[1] /= len2;

    // Dot product: if < 0.5, direction changed by > 60 degrees → corner.
    const dot = dir1[0] * dir2[0] + dir1[1] * dir2[1];
    if (dot < 0.5) {
      corners.push(i);
    }
  }

  return corners;
}

/** Fit a straight line to a run of boundary pixels and compute all rail candidate metrics. */
function fitRailToRun(
  run: readonly Px[],
  occludedSet: Set<string>
): RailCandidate | null {
  if (run.length < MIN_RAIL_PIXELS) {
    return null;
  }

  // Fit a line using least squares (PCA on the run).
  const centerX = run.reduce((sum, [x]) => sum + x, 0) / run.length;
  const centerY = run.reduce((sum, [, y]) => sum + y, 0) / run.length;

  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of run) {
    const dx = x - centerX;
    const dy = y - centerY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }

  // Compute the principal axis (direction of maximum variance).
  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const discriminant = Math.max(0, (trace / 2) ** 2 - det);
  const lambda = trace / 2 + Math.sqrt(discriminant);

  let vx: number, vy: number;
  if (Math.abs(xy) > 1e-9) {
    vx = lambda - yy;
    vy = xy;
  } else if (xx > yy) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }

  const norm = Math.sqrt(vx * vx + vy * vy);
  if (norm < 1e-9) {
    return null;
  }
  vx /= norm;
  vy /= norm;

  // Compute angle from the direction vector.
  const angleRad = Math.atan2(vy, vx);

  // Project all run pixels onto the fitted line and compute straightness.
  const projections: number[] = [];
  let sumSquaredDev = 0;

  for (const [x, y] of run) {
    const dx = x - centerX;
    const dy = y - centerY;
    const proj = dx * vx + dy * vy;
    projections.push(proj);

    // Perpendicular deviation from the line.
    const perpDev = -dx * vy + dy * vx;
    sumSquaredDev += perpDev * perpDev;
  }

  // Compute metrics.
  const minProj = Math.min(...projections);
  const maxProj = Math.max(...projections);
  const lengthPx = maxProj - minProj;

  // Straightness score: 1 - (RMS deviation / lengthPx), clamped to [0, 1].
  // This measures how well points fit the line, normalized by the line's extent.
  const rmsDeviation = Math.sqrt(sumSquaredDev / run.length);
  const straightnessScore = Math.max(0, 1 - rmsDeviation / Math.max(lengthPx, 1));

  // Compute interruption: gaps in the projection along the fitted line's axis.
  const sortedProj = projections.slice().sort((a, b) => a - b);
  let interruptionPx = 0;
  for (let i = 1; i < sortedProj.length; i++) {
    const gap = sortedProj[i] - sortedProj[i - 1];
    if (gap > 1.5) {  // Gap larger than ~1 pixel indicates a break.
      interruptionPx += gap - 1;
    }
  }

  // Compute occlusion: count how many run pixels are under an occluder.
  let occludedCount = 0;
  for (const [x, y] of run) {
    if (occludedSet.has(`${x},${y}`)) {
      occludedCount++;
    }
  }
  const occludedFractionPx = run.length > 0 ? occludedCount / run.length : 0;

  // Quality score: product of net length (accounting for interruption) and straightness.
  // Higher is better for longer, straighter, less-interrupted rails.
  const netLengthPx = Math.max(1, lengthPx - interruptionPx);
  const qualityScore = netLengthPx * straightnessScore;

  // Sort run points for deterministic output.
  const sortedRun = run.slice() as Px[];
  sortedRun.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  const sortedRunPoints = sortedRun as readonly Px[];

  return {
    points: sortedRunPoints,
    angleRad,
    lengthPx,
    straightnessScore,
    interruptionPx,
    qualityScore,
    occludedFractionPx,
  };
}
