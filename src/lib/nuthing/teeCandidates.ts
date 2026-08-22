import type { Mask } from './raster';
import type { SpriteMatch, TeeRing } from './endpoints';

export const TEE_DARK_TOUCH_BASKET_OUTLINE_FRACTION = 0.2;

export interface TeeComponentLikeMeasured {
  label: number;
  cx: number;
  cy: number;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  area: number;
  fill: number;
}

export interface MeasuredTeePoint {
  cx: number;
  cy: number;
  tier: 'ring' | 'component';
  ring?: TeeRing;
  componentLabel?: number;
  darkTouch?: number;
}

export interface TeeCandidateStats {
  basketOutlineTouchSamples: number[];
  basketOutlineTouchMedian: number;
  componentDarkTouchMin: number;
  ringsInput: number;
  ringTeeRects: number;
  diamonds: number;
  componentsInput: number;
  dimensionSurvivors: number;
  areaSurvivors: number;
  fillSurvivors: number;
  darkTouchSurvivors: number;
  removedNearRing: number;
  removedNearDiamond: number;
  removedNearSprite: number;
  componentAccepted: number;
  totalAccepted: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function countDarkTouchingBrightPixels(
  bright: Mask,
  dark: Mask,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  brightPredicate?: (index: number) => boolean,
): number {
  const width = bright.width;
  const height = bright.height;
  const touched = new Set<number>();
  const xx0 = Math.max(0, x0);
  const yy0 = Math.max(0, y0);
  const xx1 = Math.min(width, x1);
  const yy1 = Math.min(height, y1);
  for (let y = yy0; y < yy1; y++) {
    const row = y * width;
    for (let x = xx0; x < xx1; x++) {
      const i = row + x;
      if (!bright.data[i]) continue;
      if (brightPredicate && !brightPredicate(i)) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = ny * width + nx;
          if (dark.data[ni]) touched.add(ni);
        }
      }
    }
  }
  return touched.size;
}

export function measureBasketOutlineDarkTouch(
  bright: Mask,
  dark: Mask,
  sprites: SpriteMatch[],
): { samples: number[]; median: number; minimum: number } {
  const strong = sprites.filter((s) => s.score >= 0.8);
  const reference = strong.length >= 3 ? strong : sprites;
  const samples = reference.map((s) =>
    countDarkTouchingBrightPixels(bright, dark, s.x, s.y, s.x + 42, s.y + 66),
  );
  const med = median(samples);
  return {
    samples,
    median: med,
    minimum: Math.ceil(TEE_DARK_TOUCH_BASKET_OUTLINE_FRACTION * med),
  };
}

export function collectMeasuredTeeCandidates(
  rings: TeeRing[],
  components: TeeComponentLikeMeasured[],
  sprites: SpriteMatch[],
  bright: Mask,
  dark: Mask,
  brightLabels: Int32Array,
): { points: MeasuredTeePoint[]; stats: TeeCandidateStats } {
  const basketTouch = measureBasketOutlineDarkTouch(bright, dark, sprites);
  const points: MeasuredTeePoint[] = rings
    .filter((r) => r.kind === 'tee-rect')
    .map((r) => ({ cx: r.cx, cy: r.cy, tier: 'ring' as const, ring: r }));
  const diamonds = rings.filter((r) => r.kind === 'diamond');

  let dimensionSurvivors = 0;
  let areaSurvivors = 0;
  let fillSurvivors = 0;
  let darkTouchSurvivors = 0;
  let removedNearRing = 0;
  let removedNearDiamond = 0;
  let removedNearSprite = 0;
  let componentAccepted = 0;

  for (const c of components) {
    const minDim = Math.min(c.bboxW, c.bboxH);
    const maxDim = Math.max(c.bboxW, c.bboxH);
    if (minDim < 8 || maxDim > 42) continue;
    dimensionSurvivors++;
    if (c.area < 80 || c.area > 350) continue;
    areaSurvivors++;
    if (c.fill < 0.2 || c.fill > 0.85) continue;
    fillSurvivors++;

    const darkTouch = countDarkTouchingBrightPixels(
      bright,
      dark,
      c.bboxX,
      c.bboxY,
      c.bboxX + c.bboxW,
      c.bboxY + c.bboxH,
      (i) => brightLabels[i] === c.label,
    );
    if (darkTouch < basketTouch.minimum) continue;
    darkTouchSurvivors++;

    if (points.some((t) => Math.hypot(t.cx - c.cx, t.cy - c.cy) < 12)) {
      removedNearRing++;
      continue;
    }
    if (diamonds.some((d) => Math.hypot(d.cx - c.cx, d.cy - c.cy) < 12)) {
      removedNearDiamond++;
      continue;
    }
    if (sprites.some((s) => Math.hypot(s.cx - c.cx, s.cy - c.cy) < 24)) {
      removedNearSprite++;
      continue;
    }
    points.push({
      cx: c.cx,
      cy: c.cy,
      tier: 'component',
      componentLabel: c.label,
      darkTouch,
    });
    componentAccepted++;
  }

  return {
    points,
    stats: {
      basketOutlineTouchSamples: basketTouch.samples,
      basketOutlineTouchMedian: basketTouch.median,
      componentDarkTouchMin: basketTouch.minimum,
      ringsInput: rings.length,
      ringTeeRects: rings.filter((r) => r.kind === 'tee-rect').length,
      diamonds: diamonds.length,
      componentsInput: components.length,
      dimensionSurvivors,
      areaSurvivors,
      fillSurvivors,
      darkTouchSurvivors,
      removedNearRing,
      removedNearDiamond,
      removedNearSprite,
      componentAccepted,
      totalAccepted: points.length,
    },
  };
}
