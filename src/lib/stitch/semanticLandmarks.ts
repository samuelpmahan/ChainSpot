/**
 * Cheap, OpenCV-free source-raster landmark localization for stitch seeding.
 *
 * This deliberately mirrors the proven mask/shape ideas in rawObjectMask.ts
 * without invoking Pancake or assigning hole identity. The important
 * difference is batch-level family consensus: a tile with one visible badge
 * or basket can inherit size/shape priors learned from the other submitted
 * tiles.
 */

export type SemanticLandmarkFamily = 'badge' | 'basket';

export interface SemanticRaster {
  readonly sourceId: string;
  readonly rgba: Uint8Array | Uint8ClampedArray;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface SemanticLandmarkGeometry {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly areaPx: number;
  readonly fill: number;
}

export interface SemanticLandmark extends SemanticLandmarkGeometry {
  readonly sourceId: string;
  readonly family: SemanticLandmarkFamily;
}

export interface SemanticFamilyScale {
  readonly family: SemanticLandmarkFamily;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly areaPx: number;
  readonly support: number;
  readonly sourceSupport: number;
}

export type SemanticFamilyAbstentionReason = 'no-shape-candidates' | 'insufficient-batch-consensus';

export interface SemanticSourceLandmarks {
  readonly sourceId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly landmarks: readonly SemanticLandmark[];
}

export interface SemanticLandmarkDiagnostics {
  readonly elapsedMs: number;
  readonly brightComponentCount: number;
  readonly darkComponentCount: number;
  readonly badgeShapePoolCount: number;
  readonly basketShapePoolCount: number;
  readonly badgeAbstention: SemanticFamilyAbstentionReason | null;
  readonly basketAbstention: SemanticFamilyAbstentionReason | null;
}

export interface SemanticLandmarkBatchResult {
  readonly sources: readonly SemanticSourceLandmarks[];
  readonly scales: Readonly<Partial<Record<SemanticLandmarkFamily, SemanticFamilyScale>>>;
  readonly diagnostics: SemanticLandmarkDiagnostics;
}

export interface SemanticLandmarkTuning {
  readonly brightValueMin: number;
  readonly brightSaturationMax: number;
  readonly darkValueMax: number;
  readonly basketPoolMinAreaPx: number;
  readonly basketPoolMinWidthPx: number;
  readonly basketPoolMinHeightPx: number;
  readonly basketPoolAspectMin: number;
  readonly basketPoolAspectMax: number;
  readonly basketPoolFillMin: number;
  readonly basketPoolFillMax: number;
  readonly badgePoolMinAreaPx: number;
  readonly badgePoolMinWidthPx: number;
  readonly badgePoolMinHeightPx: number;
  readonly badgePoolAspectMin: number;
  readonly badgePoolAspectMax: number;
  readonly badgePoolFillMin: number;
  readonly familySizeRelTolerance: number;
  readonly familyAreaRelTolerance: number;
  readonly minBatchFamilySupport: number;
}

export const SEMANTIC_LANDMARK_DEFAULTS: SemanticLandmarkTuning = Object.freeze({
  brightValueMin: 210,
  brightSaturationMax: 45,
  darkValueMax: 45,
  basketPoolMinAreaPx: 80,
  basketPoolMinWidthPx: 8,
  basketPoolMinHeightPx: 12,
  basketPoolAspectMin: 1.25,
  basketPoolAspectMax: 2.2,
  basketPoolFillMin: 0.26,
  basketPoolFillMax: 0.8,
  badgePoolMinAreaPx: 80,
  badgePoolMinWidthPx: 12,
  badgePoolMinHeightPx: 9,
  badgePoolAspectMin: 1.15,
  badgePoolAspectMax: 1.75,
  badgePoolFillMin: 0.6,
  familySizeRelTolerance: 0.12,
  familyAreaRelTolerance: 0.22,
  minBatchFamilySupport: 2
});

interface Component extends SemanticLandmarkGeometry {
  readonly sourceIndex: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function collectComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  sourceIndex: number
): Component[] {
  const queue = new Int32Array(mask.length);
  const out: Component[] = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (mask[seed] !== 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    mask[seed] = 2;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
        const row = ny * width;
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
          if (nx === x && ny === y) continue;
          const neighbor = row + nx;
          if (mask[neighbor] !== 1) continue;
          mask[neighbor] = 2;
          queue[tail++] = neighbor;
        }
      }
    }
    if (area === 0) continue;
    const widthPx = maxX - minX + 1;
    const heightPx = maxY - minY + 1;
    out.push({
      sourceIndex,
      minX,
      minY,
      maxX,
      maxY,
      xPx: (minX + maxX) / 2,
      yPx: (minY + maxY) / 2,
      widthPx,
      heightPx,
      areaPx: area,
      fill: area / (widthPx * heightPx)
    });
  }
  return out;
}

function familyCluster(
  candidates: readonly Component[],
  tuning: SemanticLandmarkTuning
): readonly Component[] {
  let best: readonly Component[] = [];
  let bestSourceSupport = -1;
  let bestSpread = Number.POSITIVE_INFINITY;
  for (const anchor of candidates) {
    const widthTolerance = Math.max(2, anchor.widthPx * tuning.familySizeRelTolerance);
    const heightTolerance = Math.max(2, anchor.heightPx * tuning.familySizeRelTolerance);
    const areaTolerance = Math.max(30, anchor.areaPx * tuning.familyAreaRelTolerance);
    const cluster = candidates.filter(
      (candidate) =>
        Math.abs(candidate.widthPx - anchor.widthPx) <= widthTolerance &&
        Math.abs(candidate.heightPx - anchor.heightPx) <= heightTolerance &&
        Math.abs(candidate.areaPx - anchor.areaPx) <= areaTolerance
    );
    const sourceSupport = new Set(cluster.map((candidate) => candidate.sourceIndex)).size;
    const spread = cluster.reduce(
      (sum, candidate) =>
        sum +
        Math.abs(candidate.widthPx - anchor.widthPx) / Math.max(1, anchor.widthPx) +
        Math.abs(candidate.heightPx - anchor.heightPx) / Math.max(1, anchor.heightPx),
      0
    );
    if (
      cluster.length > best.length ||
      (cluster.length === best.length && sourceSupport > bestSourceSupport) ||
      (cluster.length === best.length && sourceSupport === bestSourceSupport && spread < bestSpread)
    ) {
      best = cluster;
      bestSourceSupport = sourceSupport;
      bestSpread = spread;
    }
  }
  return best;
}

function makeScale(family: SemanticLandmarkFamily, cluster: readonly Component[]): SemanticFamilyScale {
  return {
    family,
    widthPx: median(cluster.map((component) => component.widthPx)),
    heightPx: median(cluster.map((component) => component.heightPx)),
    areaPx: median(cluster.map((component) => component.areaPx)),
    support: cluster.length,
    sourceSupport: new Set(cluster.map((component) => component.sourceIndex)).size
  };
}

function centerFallsInsideBadge(component: Component, badges: readonly Component[], marginPx: number): boolean {
  return badges.some(
    (badge) =>
      badge.sourceIndex === component.sourceIndex &&
      component.xPx >= badge.minX - marginPx &&
      component.xPx <= badge.maxX + marginPx &&
      component.yPx >= badge.minY - marginPx &&
      component.yPx <= badge.maxY + marginPx
  );
}

export function detectSemanticLandmarkBatch(
  rasters: readonly SemanticRaster[],
  overrides?: Partial<SemanticLandmarkTuning>
): SemanticLandmarkBatchResult {
  const started = nowMs();
  const tuning: SemanticLandmarkTuning = overrides
    ? { ...SEMANTIC_LANDMARK_DEFAULTS, ...overrides }
    : SEMANTIC_LANDMARK_DEFAULTS;
  const brightComponents: Component[] = [];
  const darkComponents: Component[] = [];

  rasters.forEach((raster, sourceIndex) => {
    const { widthPx: width, heightPx: height, rgba } = raster;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length < width * height * 4) {
      throw new Error(`Invalid semantic stitch raster: ${raster.sourceId}`);
    }
    const bright = new Uint8Array(width * height);
    const dark = new Uint8Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
      if (max > tuning.brightValueMin && saturation < tuning.brightSaturationMax) bright[index] = 1;
      if (max <= tuning.darkValueMax) dark[index] = 1;
    }
    brightComponents.push(...collectComponents(bright, width, height, sourceIndex));
    darkComponents.push(...collectComponents(dark, width, height, sourceIndex));
  });

  const badgeShapePool = darkComponents.filter((component) => {
    const aspect = component.widthPx / component.heightPx;
    return (
      component.areaPx >= tuning.badgePoolMinAreaPx &&
      component.widthPx >= tuning.badgePoolMinWidthPx &&
      component.heightPx >= tuning.badgePoolMinHeightPx &&
      aspect >= tuning.badgePoolAspectMin &&
      aspect <= tuning.badgePoolAspectMax &&
      component.fill >= tuning.badgePoolFillMin
    );
  });
  const badgeCluster = familyCluster(badgeShapePool, tuning);
  const acceptedBadges = badgeCluster.length >= tuning.minBatchFamilySupport ? badgeCluster : [];
  const badgeScale = acceptedBadges.length > 0 ? makeScale('badge', acceptedBadges) : undefined;

  const badgeExclusionMargin = badgeScale ? Math.max(2, badgeScale.heightPx * 0.08) : 0;
  const basketShapePool = brightComponents.filter((component) => {
    if (acceptedBadges.length > 0 && centerFallsInsideBadge(component, acceptedBadges, badgeExclusionMargin)) return false;
    const aspect = component.heightPx / component.widthPx;
    return (
      component.areaPx >= tuning.basketPoolMinAreaPx &&
      component.widthPx >= tuning.basketPoolMinWidthPx &&
      component.heightPx >= tuning.basketPoolMinHeightPx &&
      aspect >= tuning.basketPoolAspectMin &&
      aspect <= tuning.basketPoolAspectMax &&
      component.fill >= tuning.basketPoolFillMin &&
      component.fill <= tuning.basketPoolFillMax
    );
  });
  const basketCluster = familyCluster(basketShapePool, tuning);
  const acceptedBaskets = basketCluster.length >= tuning.minBatchFamilySupport ? basketCluster : [];
  const basketScale = acceptedBaskets.length > 0 ? makeScale('basket', acceptedBaskets) : undefined;

  const bySource = rasters.map((raster, sourceIndex): SemanticSourceLandmarks => {
    const landmarks: SemanticLandmark[] = [];
    for (const component of acceptedBadges) {
      if (component.sourceIndex !== sourceIndex) continue;
      landmarks.push({ sourceId: raster.sourceId, family: 'badge', ...pickGeometry(component) });
    }
    for (const component of acceptedBaskets) {
      if (component.sourceIndex !== sourceIndex) continue;
      landmarks.push({ sourceId: raster.sourceId, family: 'basket', ...pickGeometry(component) });
    }
    landmarks.sort((a, b) => a.family.localeCompare(b.family) || a.yPx - b.yPx || a.xPx - b.xPx);
    return { sourceId: raster.sourceId, widthPx: raster.widthPx, heightPx: raster.heightPx, landmarks };
  });

  const scales: Partial<Record<SemanticLandmarkFamily, SemanticFamilyScale>> = {};
  if (badgeScale) scales.badge = badgeScale;
  if (basketScale) scales.basket = basketScale;
  return {
    sources: bySource,
    scales,
    diagnostics: {
      elapsedMs: nowMs() - started,
      brightComponentCount: brightComponents.length,
      darkComponentCount: darkComponents.length,
      badgeShapePoolCount: badgeShapePool.length,
      basketShapePoolCount: basketShapePool.length,
      badgeAbstention:
        badgeShapePool.length === 0 ? 'no-shape-candidates' : acceptedBadges.length === 0 ? 'insufficient-batch-consensus' : null,
      basketAbstention:
        basketShapePool.length === 0 ? 'no-shape-candidates' : acceptedBaskets.length === 0 ? 'insufficient-batch-consensus' : null
    }
  };
}

function pickGeometry(component: Component): SemanticLandmarkGeometry {
  return {
    xPx: component.xPx,
    yPx: component.yPx,
    widthPx: component.widthPx,
    heightPx: component.heightPx,
    areaPx: component.areaPx,
    fill: component.fill
  };
}
