import { describe, expect, it } from 'vitest';
import type { ComponentStats } from '../../src/lib/nuthing/components';
import {
  detectScreenChromeRegions,
  pointInScreenChrome,
} from '../../src/lib/nuthing/screenChrome';

function comp(
  label: number,
  x: number,
  y: number,
  w: number,
  h: number,
): ComponentStats {
  return {
    label,
    cx: x + w / 2,
    cy: y + h / 2,
    area: Math.max(12, Math.round(w * h * 0.5)),
    bboxX: x,
    bboxY: y,
    bboxW: w,
    bboxH: h,
    major: Math.max(w, h),
    minor: Math.min(w, h),
    angle: 0,
    fill: 0.5,
  };
}

describe('screen chrome attribution', () => {
  it('groups a bottom-edge multi-glyph UI control into one chrome parent', () => {
    const width = 400;
    const height = 1000;
    const components = [
      comp(1, 2, 956, 20, 28),
      comp(2, 30, 958, 18, 24),
      comp(3, 56, 957, 16, 26),
      comp(4, 82, 958, 18, 24),
      comp(5, 110, 956, 20, 28),
      comp(6, 140, 958, 22, 24),
      comp(7, 170, 956, 20, 28),
    ];

    const regions = detectScreenChromeRegions(components, width, height);
    expect(regions).toHaveLength(1);
    expect(regions[0].componentCount).toBe(7);
    expect(pointInScreenChrome(65, 970, regions)).toBe(true);
  });

  it('does not blanket-suppress an isolated tee-like object near the bottom edge', () => {
    const regions = detectScreenChromeRegions(
      [comp(1, 180, 955, 24, 18)],
      400,
      1000,
    );
    expect(regions).toEqual([]);
  });

  it('does not attribute a similar multi-component cluster away from screen edges', () => {
    const components = [
      comp(1, 110, 955, 18, 24),
      comp(2, 136, 956, 18, 24),
      comp(3, 162, 955, 18, 24),
      comp(4, 188, 956, 18, 24),
      comp(5, 214, 955, 18, 24),
      comp(6, 240, 956, 18, 24),
    ];
    const regions = detectScreenChromeRegions(components, 500, 1000);
    expect(regions).toEqual([]);
  });
});
