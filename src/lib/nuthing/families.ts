/**
 * Repeated-family discovery over component size space, matching the baseline's
 * anchored_families / family_spread semantics exactly (including stable
 * ordering: anchor order determines first-seen family order; the final sort by
 * size is stable, so equal-size families keep anchor order).
 */

import type { ComponentStats } from './components';

export function logSizeDistance(
  aMajor: number,
  aMinor: number,
  bMajor: number,
  bMinor: number,
): number {
  return Math.max(
    Math.abs(Math.log(aMajor / bMajor)),
    Math.abs(Math.log(aMinor / bMinor)),
  );
}

export function componentSizeDistance(a: ComponentStats, b: ComponentStats): number {
  return logSizeDistance(a.major, a.minor, b.major, b.minor);
}

export function bboxSizeDistance(a: ComponentStats, b: ComponentStats): number {
  return Math.max(
    Math.abs(Math.log(a.bboxW / b.bboxW)),
    Math.abs(Math.log(a.bboxH / b.bboxH)),
  );
}

/** np.median: mean of the two middle elements for even-length input. */
export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function anchoredFamilies(
  components: ComponentStats[],
  tolerance: number,
  distanceFn: (a: ComponentStats, b: ComponentStats) => number = componentSizeDistance,
): ComponentStats[][] {
  const families: ComponentStats[][] = [];
  const seen = new Set<string>();
  for (const anchor of components) {
    const family = components.filter((c) => distanceFn(anchor, c) <= tolerance);
    const key = family
      .map((c) => c.label)
      .sort((a, b) => a - b)
      .join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    families.push(family);
  }
  // Stable sort by size descending (Array.prototype.sort is stable per spec).
  return families
    .map((f, i) => [f, i] as const)
    .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
    .map(([f]) => f);
}

export function familySpread(family: ComponentStats[]): number {
  if (family.length === 0) return Infinity;
  const major = median(family.map((c) => c.major));
  const minor = median(family.map((c) => c.minor));
  return median(family.map((c) => logSizeDistance(c.major, c.minor, major, minor)));
}
