import { describe, expect, it } from 'vitest';
import {
  deterministicOccluderExitDistancePx,
  seedFourLaneState,
  trackFourLaneRibbon,
  type FourLaneOccluder,
} from '../../src/lib/nuthing/fourLaneRibbon';
import type { RgbaImage } from '../../src/lib/nuthing/raster';

function blankImage(width = 120, height = 100): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

describe('four-lane known-occluder traversal', () => {
  it('computes the geometric centerline exit distance from an axis-aligned box', () => {
    const box: FourLaneOccluder = { bboxX: 40, bboxY: 40, bboxW: 20, bboxH: 20, kind: 'badge' };

    expect(
      deterministicOccluderExitDistancePx(
        { xPx: 50, yPx: 50, headingRad: 0, corridorWidthPx: 30 },
        box,
      ),
    ).toBeCloseTo(10, 8);

    expect(
      deterministicOccluderExitDistancePx(
        { xPx: 50, yPx: 50, headingRad: Math.PI / 4, corridorWidthPx: 30 },
        box,
      ),
    ).toBeCloseTo(10 * Math.SQRT2, 8);

    expect(
      deterministicOccluderExitDistancePx(
        { xPx: 70, yPx: 50, headingRad: 0, corridorWidthPx: 30 },
        box,
      ),
    ).toBe(0);
  });

  it('does not optimize heading while crossing the seed occluder', () => {
    const image = blankImage();
    const box: FourLaneOccluder = { bboxX: 40, bboxY: 40, bboxW: 20, bboxH: 20, kind: 'badge' };
    const start = seedFourLaneState({ xPx: 30, yPx: 50 }, { xPx: 50, yPx: 50 }, 30);

    const result = trackFourLaneRibbon(image, start, [box], {
      stepPx: 6,
      maxDistancePx: 24,
      failureSteps: 99,
      maxUnknownSteps: 99,
    });

    // Centerline exit is 10px. The contract keeps one full 6px tracker step
    // beyond that exit deterministic, so the first three transitions are
    // geometry-owned rather than evidence-owned.
    expect(result.steps.slice(0, 3).map((step) => step.deterministicOccluderTransit)).toEqual([
      true,
      true,
      true,
    ]);
    expect(result.steps.slice(0, 3).map((step) => step.headingDeltaDeg)).toEqual([0, 0, 0]);
    expect(result.steps[3].deterministicOccluderTransit).toBe(false);
    expect(result.points.slice(0, 4).map((point) => point.xPx)).toEqual([50, 56, 62, 68]);
  });
});
