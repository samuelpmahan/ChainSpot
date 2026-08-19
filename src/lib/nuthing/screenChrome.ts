import type { ComponentStats } from './components';

/**
 * Residual screen-space map chrome that survives viewport auto-crop.
 *
 * UDisc course geometry is rendered into map space; Apple Maps attribution
 * and controls (the Apple/Maps mark, MAP/SAT pill, etc.) are screen-space UI.
 * Their individual white glyph fragments can satisfy the hollow-ring / tee
 * fallback geometry, but the *parent neighborhood* is unmistakably chrome:
 * a wide, multi-component, screen-axis cluster anchored to the bottom-left
 * or bottom-right edge.
 *
 * This module attributes those parent clusters explicitly. It does NOT
 * tighten tee geometry and does NOT blanket-suppress an edge strip: a real
 * hole is allowed near an image edge. Only candidate centers inside a
 * detected chrome parent region should be discounted/removed.
 */

export interface ScreenChromeRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  componentCount: number;
}

const MIN_BOTTOM_BAND_PX = 96;
const BOTTOM_BAND_FRACTION = 0.05;
const EXPAND_X = 10;
const EXPAND_Y = 2;
const EDGE_ANCHOR_PX = 32;
const BOTTOM_ANCHOR_PX = 32;
const MIN_COMPONENTS = 5;
const MIN_CLUSTER_WIDTH = 140;
const VERY_WIDE_CLUSTER = 220;
const MIN_CLUSTER_HEIGHT = 16;
const MAX_CLUSTER_HEIGHT = 90;

interface ExpandedComponent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: ExpandedComponent, b: ExpandedComponent): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

/**
 * Detect bottom-edge screen chrome from the bright-component universe.
 *
 * The expansion is intentionally anisotropic (10 px horizontal, 2 px
 * vertical): text/control glyphs on one UI baseline should join into their
 * parent control, while nearby course geometry above the control should not.
 *
 * Measured on the five current course rasters, this finds exactly the two
 * obvious AlexClark parent regions (MAP/SAT and Apple Maps attribution) and
 * removes their tee-like children without removing any of the 69/72 baseline
 * dev truth tees.
 */
export function detectScreenChromeRegions(
  components: readonly ComponentStats[],
  width: number,
  height: number,
): ScreenChromeRegion[] {
  const bandDepth = Math.max(MIN_BOTTOM_BAND_PX, Math.round(height * BOTTOM_BAND_FRACTION));
  const bandTop = height - bandDepth;

  const nodes: ExpandedComponent[] = [];
  for (const c of components) {
    const bottom = c.bboxY + c.bboxH;
    if (bottom < bandTop) continue;
    nodes.push({
      x0: c.bboxX - EXPAND_X,
      y0: c.bboxY - EXPAND_Y,
      x1: c.bboxX + c.bboxW + EXPAND_X,
      y1: c.bboxY + c.bboxH + EXPAND_Y,
    });
  }
  if (nodes.length === 0) return [];

  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (overlaps(nodes[i], nodes[j])) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  const regions: ScreenChromeRegion[] = [];
  for (const ids of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of ids) {
      const n = nodes[i];
      if (n.x0 < x0) x0 = n.x0;
      if (n.y0 < y0) y0 = n.y0;
      if (n.x1 > x1) x1 = n.x1;
      if (n.y1 > y1) y1 = n.y1;
    }
    const w = x1 - x0;
    const h = y1 - y0;
    if (ids.length < MIN_COMPONENTS) continue;
    if (w < MIN_CLUSTER_WIDTH) continue;
    if (h < MIN_CLUSTER_HEIGHT || h > MAX_CLUSTER_HEIGHT) continue;

    const edgeAnchored = x0 <= EDGE_ANCHOR_PX || x1 >= width - EDGE_ANCHOR_PX;
    const bottomAnchored = y1 >= height - BOTTOM_ANCHOR_PX || w >= VERY_WIDE_CLUSTER;
    if (!edgeAnchored || !bottomAnchored) continue;

    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(width, x1);
    const cy1 = Math.min(height, y1);
    regions.push({
      x: cx0,
      y: cy0,
      width: Math.max(0, cx1 - cx0),
      height: Math.max(0, cy1 - cy0),
      componentCount: ids.length,
    });
  }
  return regions;
}

export function pointInScreenChrome(
  x: number,
  y: number,
  regions: readonly ScreenChromeRegion[],
  padding = 4,
): boolean {
  return regions.some(
    (r) =>
      x >= r.x - padding &&
      x <= r.x + r.width + padding &&
      y >= r.y - padding &&
      y <= r.y + r.height + padding,
  );
}
