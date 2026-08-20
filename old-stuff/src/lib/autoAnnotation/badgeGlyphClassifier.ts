/**
 * Cheapest possible hole-number classifier for an already-localized badge body.
 *
 * This module never searches a whole raster for badges. The physical body is
 * an input. Pure TypeScript normalizes the bright glyph inside that dark body
 * and compares it only with the manifest's existing hole-number templates.
 * If that abstains, `classifyKnownBadgeBodiesWithOpenCv` reuses the existing
 * P2 glyph/NCC implementation on the same known ROIs; it still performs no
 * whole-raster badge discovery.
 */
import {
  labelKnownHoleNumberBadges,
  type HoleNumberCvModule,
  type HoleNumberTemplate,
  type KnownBadgeBody
} from './holeNumberDetection';

export interface BadgeGlyphRaster {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface BadgeGlyphTemplatePack {
  readonly templates: readonly HoleNumberTemplate[];
  readonly vocabularyLabels: readonly number[];
  readonly canonicalBadge: Readonly<{ widthPx: number; heightPx: number }>;
}

export type BadgeGlyphMethod = 'pure-ts' | 'roi-opencv';
export type BadgeGlyphAbstention =
  | 'empty-glyph'
  | 'low-score'
  | 'ambiguous'
  | 'opencv-unlabeled';

export interface BadgeGlyphClassification {
  readonly badgeIndex: number;
  readonly method: BadgeGlyphMethod;
  readonly label?: number;
  readonly bestLabel?: number;
  readonly bestScore: number;
  readonly runnerUpScore: number;
  readonly ambiguityMargin: number;
  readonly abstention: BadgeGlyphAbstention | null;
  readonly elapsedMs: number;
}

export interface BadgeGlyphClassifierOptions {
  readonly minScore?: number;
  readonly minMargin?: number;
  readonly foregroundThreshold?: number;
  readonly normalizedWidthPx?: number;
  readonly normalizedHeightPx?: number;
  readonly maxShiftPx?: number;
}

const DEFAULTS: Required<BadgeGlyphClassifierOptions> = Object.freeze({
  minScore: 0.58,
  minMargin: 0.045,
  foregroundThreshold: 150,
  normalizedWidthPx: 24,
  normalizedHeightPx: 18,
  maxShiftPx: 1
});

const templatePackPromises = new Map<string, Promise<BadgeGlyphTemplatePack>>();

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function resourceRoot(basePath: string): string {
  const clean = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${clean}/resources/chainspot_cv_templates`;
}

function positiveFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function templateFile(value: unknown, index: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+\.png$/.test(value)) {
    throw new Error(`Hole-number template ${index + 1} must be a local PNG filename.`);
  }
  const expected = `hole-${String(index + 1).padStart(2, '0')}.png`;
  if (value !== expected) {
    throw new Error(`Hole-number template ${index + 1} must be ${expected}; received ${value}.`);
  }
  return value;
}

async function rasterizeTemplate(url: string, label: number): Promise<HoleNumberTemplate> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Hole-number template ${label} could not be loaded (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error(`Could not rasterize hole-number template ${label}.`);
    context.drawImage(bitmap, 0, 0);
    return {
      label,
      raster: {
        format: 'rgba',
        widthPx: bitmap.width,
        heightPx: bitmap.height,
        data: context.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Manifest-driven on purpose: the vocabulary length is whatever is actually
 * shipped. There is no compiled 9/18/24-hole assumption here.
 */
export function loadBadgeGlyphTemplatePack(basePath: string): Promise<BadgeGlyphTemplatePack> {
  const root = resourceRoot(basePath);
  const cached = templatePackPromises.get(root);
  if (cached) return cached;
  const loading = fetch(`${root}/manifest.json`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`CV template manifest could not be loaded (${response.status}).`);
      const raw = (await response.json()) as {
        schemaVersion?: unknown;
        calibration?: { canonicalNumberBadge?: { widthPx?: unknown; heightPx?: unknown } };
        templates?: { holeNumbers?: unknown };
      };
      if (raw.schemaVersion !== 1) throw new Error('CV template manifest schemaVersion must be 1.');
      const files = raw.templates?.holeNumbers;
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('CV template manifest must list at least one hole-number template.');
      }
      const canonicalBadge = {
        widthPx: positiveFinite(raw.calibration?.canonicalNumberBadge?.widthPx, 'Canonical badge width'),
        heightPx: positiveFinite(raw.calibration?.canonicalNumberBadge?.heightPx, 'Canonical badge height')
      };
      const names = files.map(templateFile);
      const templates = await Promise.all(
        names.map((fileName, index) => rasterizeTemplate(`${root}/${fileName}`, index + 1))
      );
      return {
        templates,
        vocabularyLabels: templates.map((template) => template.label),
        canonicalBadge
      };
    })
    .catch((error) => {
      templatePackPromises.delete(root);
      throw error;
    });
  templatePackPromises.set(root, loading);
  return loading;
}

function rgbaAt(raster: BadgeGlyphRaster, x: number, y: number): readonly [number, number, number] {
  const clampedX = Math.max(0, Math.min(raster.widthPx - 1, x));
  const clampedY = Math.max(0, Math.min(raster.heightPx - 1, y));
  const offset = (clampedY * raster.widthPx + clampedX) * 4;
  return [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]];
}

function brightNeutral(r: number, g: number, b: number, threshold: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max >= threshold && max - min <= 90;
}

interface BinaryMask {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly data: Uint8Array;
  readonly foreground: number;
}

function rawBadgeGlyphMask(
  raster: BadgeGlyphRaster,
  badge: Readonly<{ xPx: number; yPx: number; widthPx: number; heightPx: number }>,
  threshold: number,
  sampleWidthPx: number,
  sampleHeightPx: number
): BinaryMask {
  const data = new Uint8Array(sampleWidthPx * sampleHeightPx);
  const left = badge.xPx - badge.widthPx / 2;
  const top = badge.yPx - badge.heightPx / 2;
  const marginX = 0.14;
  const marginY = 0.16;
  let foreground = 0;
  for (let y = 0; y < sampleHeightPx; y += 1) {
    const v = (y + 0.5) / sampleHeightPx;
    if (v < marginY || v > 1 - marginY) continue;
    for (let x = 0; x < sampleWidthPx; x += 1) {
      const u = (x + 0.5) / sampleWidthPx;
      if (u < marginX || u > 1 - marginX) continue;
      const sourceX = Math.round(left + u * badge.widthPx - 0.5);
      const sourceY = Math.round(top + v * badge.heightPx - 0.5);
      const [r, g, b] = rgbaAt(raster, sourceX, sourceY);
      if (!brightNeutral(r, g, b, threshold)) continue;
      data[y * sampleWidthPx + x] = 1;
      foreground += 1;
    }
  }
  return { widthPx: sampleWidthPx, heightPx: sampleHeightPx, data, foreground };
}

function tightBounds(mask: BinaryMask): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = mask.widthPx;
  let minY = mask.heightPx;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.heightPx; y += 1) {
    for (let x = 0; x < mask.widthPx; x += 1) {
      if (!mask.data[y * mask.widthPx + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** Tight glyph bbox -> aspect-preserving canonical binary mask. */
export function normalizeBadgeGlyphMask(
  raster: BadgeGlyphRaster,
  badge: Readonly<{ xPx: number; yPx: number; widthPx: number; heightPx: number }>,
  options: BadgeGlyphClassifierOptions = {}
): BinaryMask | null {
  const p = { ...DEFAULTS, ...options };
  const sampled = rawBadgeGlyphMask(raster, badge, p.foregroundThreshold, 48, 36);
  const bounds = tightBounds(sampled);
  if (!bounds) return null;
  const sourceWidth = bounds.maxX - bounds.minX + 1;
  const sourceHeight = bounds.maxY - bounds.minY + 1;
  const innerWidth = Math.max(1, p.normalizedWidthPx - 2);
  const innerHeight = Math.max(1, p.normalizedHeightPx - 2);
  const scale = Math.min(innerWidth / sourceWidth, innerHeight / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = Math.floor((p.normalizedWidthPx - drawWidth) / 2);
  const offsetY = Math.floor((p.normalizedHeightPx - drawHeight) / 2);
  const data = new Uint8Array(p.normalizedWidthPx * p.normalizedHeightPx);
  let foreground = 0;
  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = Math.min(bounds.maxY, bounds.minY + Math.floor(((y + 0.5) * sourceHeight) / drawHeight));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = Math.min(bounds.maxX, bounds.minX + Math.floor(((x + 0.5) * sourceWidth) / drawWidth));
      if (!sampled.data[sourceY * sampled.widthPx + sourceX]) continue;
      const index = (offsetY + y) * p.normalizedWidthPx + offsetX + x;
      data[index] = 1;
      foreground += 1;
    }
  }
  return { widthPx: p.normalizedWidthPx, heightPx: p.normalizedHeightPx, data, foreground };
}

function templateRaster(template: HoleNumberTemplate): BadgeGlyphRaster {
  if (template.raster.format === 'rgba') {
    return {
      data: template.raster.data,
      widthPx: template.raster.widthPx,
      heightPx: template.raster.heightPx
    };
  }
  const rgba = new Uint8Array(template.raster.widthPx * template.raster.heightPx * 4);
  for (let index = 0; index < template.raster.data.length; index += 1) {
    const value = template.raster.data[index];
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return { data: rgba, widthPx: template.raster.widthPx, heightPx: template.raster.heightPx };
}

function wholeRasterBadge(raster: BadgeGlyphRaster): { xPx: number; yPx: number; widthPx: number; heightPx: number } {
  return {
    xPx: raster.widthPx / 2,
    yPx: raster.heightPx / 2,
    widthPx: raster.widthPx,
    heightPx: raster.heightPx
  };
}

function shiftedDice(a: BinaryMask, b: BinaryMask, dx: number, dy: number): number {
  let intersection = 0;
  let aCount = 0;
  let bCount = 0;
  for (let y = 0; y < a.heightPx; y += 1) {
    for (let x = 0; x < a.widthPx; x += 1) {
      const av = a.data[y * a.widthPx + x];
      const bx = x + dx;
      const by = y + dy;
      const bv = bx >= 0 && by >= 0 && bx < b.widthPx && by < b.heightPx
        ? b.data[by * b.widthPx + bx]
        : 0;
      if (av) aCount += 1;
      if (bv) bCount += 1;
      if (av && bv) intersection += 1;
    }
  }
  if (aCount === 0 || bCount === 0) return 0;
  return (2 * intersection) / (aCount + bCount);
}

function bestMaskScore(a: BinaryMask, b: BinaryMask, maxShiftPx: number): number {
  let best = 0;
  for (let dy = -maxShiftPx; dy <= maxShiftPx; dy += 1) {
    for (let dx = -maxShiftPx; dx <= maxShiftPx; dx += 1) {
      best = Math.max(best, shiftedDice(a, b, dx, dy));
    }
  }
  return best;
}

export function classifyKnownBadgeBodiesPureTs(
  source: BadgeGlyphRaster,
  templates: readonly HoleNumberTemplate[],
  badges: readonly KnownBadgeBody[],
  options: BadgeGlyphClassifierOptions = {}
): readonly BadgeGlyphClassification[] {
  const p = { ...DEFAULTS, ...options };
  const normalizedTemplates = templates.map((template) => {
    const raster = templateRaster(template);
    return {
      label: template.label,
      mask: normalizeBadgeGlyphMask(raster, wholeRasterBadge(raster), p)
    };
  });
  return badges.map((badge, badgeIndex) => {
    const started = nowMs();
    const candidate = normalizeBadgeGlyphMask(source, badge, p);
    if (!candidate) {
      return {
        badgeIndex,
        method: 'pure-ts' as const,
        bestScore: 0,
        runnerUpScore: 0,
        ambiguityMargin: 0,
        abstention: 'empty-glyph' as const,
        elapsedMs: nowMs() - started
      };
    }
    const ranked = normalizedTemplates
      .flatMap((template) => template.mask ? [{ label: template.label, score: bestMaskScore(candidate, template.mask, p.maxShiftPx) }] : [])
      .sort((a, b) => b.score - a.score || a.label - b.label);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const bestScore = winner?.score ?? 0;
    const runnerUpScore = runnerUp?.score ?? 0;
    const ambiguityMargin = bestScore - runnerUpScore;
    const abstention: BadgeGlyphAbstention | null =
      !winner ? 'empty-glyph' : bestScore < p.minScore ? 'low-score' : ambiguityMargin < p.minMargin ? 'ambiguous' : null;
    return {
      badgeIndex,
      method: 'pure-ts',
      ...(abstention === null && winner ? { label: winner.label } : {}),
      ...(winner ? { bestLabel: winner.label } : {}),
      bestScore,
      runnerUpScore,
      ambiguityMargin,
      abstention,
      elapsedMs: nowMs() - started
    };
  });
}

/** Existing P2, but explicitly restricted to the already-known badge bodies. */
export function classifyKnownBadgeBodiesWithOpenCv(
  cv: HoleNumberCvModule,
  source: BadgeGlyphRaster,
  templates: readonly HoleNumberTemplate[],
  badges: readonly KnownBadgeBody[]
): readonly BadgeGlyphClassification[] {
  const started = nowMs();
  const detection = labelKnownHoleNumberBadges(
    cv,
    { format: 'rgba', widthPx: source.widthPx, heightPx: source.heightPx, data: source.data },
    templates,
    badges
  );
  return badges.map((badge, badgeIndex) => {
    let nearest = detection.candidates[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of detection.candidates) {
      const candidateDistance = Math.hypot(candidate.xPx - badge.xPx, candidate.yPx - badge.yPx);
      if (candidateDistance < nearestDistance) {
        nearest = candidate;
        nearestDistance = candidateDistance;
      }
    }
    const ranked = nearest?.topGlyphMatches ?? [];
    const bestScore = nearest?.glyphScore ?? ranked[0]?.score ?? -1;
    const runnerUpScore = ranked.find((entry) => entry.label !== nearest?.label)?.score ?? -1;
    const ambiguityMargin = bestScore - runnerUpScore;
    return {
      badgeIndex,
      method: 'roi-opencv',
      ...(nearest?.label !== undefined ? { label: nearest.label, bestLabel: nearest.label } : {}),
      bestScore,
      runnerUpScore,
      ambiguityMargin,
      abstention: nearest?.label === undefined ? 'opencv-unlabeled' : null,
      elapsedMs: (nowMs() - started) / Math.max(1, badges.length)
    };
  });
}

export function badgeGlyphBatchIsComplete(
  classifications: readonly BadgeGlyphClassification[]
): boolean {
  if (classifications.length === 0) return false;
  const labels = classifications.flatMap((classification) => classification.label === undefined ? [] : [classification.label]);
  return labels.length === classifications.length && new Set(labels).size === labels.length;
}
