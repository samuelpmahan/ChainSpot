import { describe, expect, it } from 'vitest';
import { computeBrightDarkMasks, opencvSaturation } from '../../src/lib/nuthing/raster';
import { extractComponents, majorAxisOf } from '../../src/lib/nuthing/components';
import {
  distanceTransformL2Mask3,
  distanceTransformL2Mask5,
  innerCore,
  shiftMask,
  CANON_SIZE,
} from '../../src/lib/nuthing/chamfer';
import {
  meanF32,
  pairwiseSumF32,
  quantileF32Linear,
  rintHalfEven,
} from '../../src/lib/nuthing/npcompat';
import { anchoredFamilies, median } from '../../src/lib/nuthing/families';
import type { ComponentStats } from '../../src/lib/nuthing/components';

describe('opencvSaturation', () => {
  it('matches OpenCV fixed-point results on reference pixels', () => {
    // Values verified against cv2.cvtColor on single pixels.
    expect(opencvSaturation(255, 255, 255)).toBe(0);
    expect(opencvSaturation(255, 0, 0)).toBe(255);
    expect(opencvSaturation(210, 200, 190)).toBe(24);
    expect(opencvSaturation(255, 210, 210)).toBe(45);
  });
});

describe('computeBrightDarkMasks', () => {
  it('applies V>=210 & S<=45 and V<=45', () => {
    const data = new Uint8Array([
      255, 255, 255, 255, // bright white
      30, 30, 30, 255, // dark
      255, 0, 0, 255, // saturated red: V ok, S too high
      100, 100, 100, 255, // mid gray: neither
    ]);
    const { bright, dark } = computeBrightDarkMasks({ width: 4, height: 1, data });
    expect([...bright.data]).toEqual([1, 0, 0, 0]);
    expect([...dark.data]).toEqual([0, 1, 0, 0]);
  });
});

describe('extractComponents', () => {
  it('labels 8-connected components with correct stats', () => {
    // Two diagonal pixels are one component under 8-connectivity.
    const mask = new Uint8Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
      0, 0, 0, 1,
    ]);
    const { components } = extractComponents({ width: 4, height: 4, data: mask });
    expect(components).toHaveLength(2);
    const [diag, vert] = components;
    expect(diag.area).toBe(2);
    expect([diag.bboxX, diag.bboxY, diag.bboxW, diag.bboxH]).toEqual([0, 0, 2, 2]);
    expect(vert.area).toBe(2);
    expect(vert.major).toBeCloseTo(2, 12);
    expect(vert.minor).toBeCloseTo(1, 12);
  });

  it('drops single-pixel components from stats (baseline behavior)', () => {
    const mask = new Uint8Array([1, 0, 0, 0]);
    const { components } = extractComponents({ width: 4, height: 1, data: mask });
    expect(components).toHaveLength(0);
  });
});

describe('majorAxisOf', () => {
  it('deflates negligible off-diagonal covariance like LAPACK', () => {
    const { ax, ay } = majorAxisOf(91.92, -2.6e-16, 276.09);
    expect(ax).toBe(0);
    expect(ay).toBe(1);
  });

  it('solves the dominant axis for a clear diagonal covariance', () => {
    const { ax, ay } = majorAxisOf(10, 4, 2);
    // Eigenvector of [[10,4],[4,2]] for the larger eigenvalue, x>0 normalized.
    const lmax = 6 + Math.sqrt(32);
    expect(ay / ax).toBeCloseTo((lmax - 10) / 4, 12);
    expect(Math.hypot(ax, ay)).toBeCloseTo(1, 12);
    expect(ax).toBeGreaterThan(0);
  });
});

describe('chamfer distance transforms', () => {
  it('uses OpenCV DIST_L2 mask3 weights (0.955, 1.3693)', () => {
    // Single zero pixel at center of 5x5; everything else nonzero.
    const src = new Uint8Array(25).fill(1);
    src[12] = 0;
    const d = distanceTransformL2Mask3(src, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[11]).toBeCloseTo(0.955, 5);
    expect(d[6]).toBeCloseTo(1.3693, 5);
    expect(d[10]).toBeCloseTo(1.91, 5);
    expect(d[0]).toBeCloseTo(2 * 1.3693, 4);
  });

  it('uses OpenCV DIST_L2 mask5 weights (1, 1.4, 2.1969 knight)', () => {
    const src = new Uint8Array(25).fill(1);
    src[12] = 0;
    const d = distanceTransformL2Mask5(src, 5, 5);
    expect(d[11]).toBeCloseTo(1.0, 6);
    expect(d[6]).toBeCloseTo(1.4, 6);
    // Knight move (2,1) from center: index (row0, col1)
    expect(d[1]).toBeCloseTo(2.1969, 5);
  });
});

describe('shiftMask / innerCore', () => {
  it('shifts with zero fill', () => {
    const m = new Uint8Array(CANON_SIZE * CANON_SIZE);
    m[10 * CANON_SIZE + 10] = 1;
    const s = shiftMask(m, 3, -2);
    expect(s[8 * CANON_SIZE + 13]).toBe(1);
    expect(s.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('innerCore keeps the deep interior', () => {
    const m = new Uint8Array(CANON_SIZE * CANON_SIZE);
    for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) m[y * CANON_SIZE + x] = 1;
    const core = innerCore(m, 0.6);
    const count = core.reduce((a: number, b) => a + b, 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(16 * 16);
    // Border pixel excluded, center kept.
    expect(core[40 * CANON_SIZE + 40]).toBe(0);
    expect(core[48 * CANON_SIZE + 48]).toBe(1);
  });
});

describe('npcompat', () => {
  it('rintHalfEven rounds halves to even including negatives', () => {
    expect(rintHalfEven(0.5)).toBe(0);
    expect(rintHalfEven(1.5)).toBe(2);
    expect(rintHalfEven(2.5)).toBe(2);
    // Sign of zero is irrelevant (result is used as an array index).
    expect(rintHalfEven(-0.5) === 0).toBe(true);
    expect(rintHalfEven(-1.5)).toBe(-2);
    expect(rintHalfEven(-2.5)).toBe(-2);
    expect(rintHalfEven(1.2)).toBe(1);
  });

  it('pairwiseSumF32 matches plain summation for exact values', () => {
    const a = new Float32Array(200).fill(0.25);
    expect(pairwiseSumF32(a, 0, 200)).toBe(50);
    expect(meanF32(a, 200)).toBe(0.25);
  });

  it('quantileF32Linear interpolates between sorted values', () => {
    const v = new Float32Array([0, 1, 2, 3, 4]);
    expect(quantileF32Linear(v, 0.5)).toBe(2);
    expect(quantileF32Linear(v, 0.4)).toBeCloseTo(1.6, 6);
    expect(quantileF32Linear(v, 1)).toBe(4);
  });
});

describe('families', () => {
  const comp = (label: number, major: number, minor: number): ComponentStats => ({
    label,
    cx: 0,
    cy: 0,
    area: 1,
    bboxX: 0,
    bboxY: 0,
    bboxW: Math.round(major),
    bboxH: Math.round(minor),
    major,
    minor,
    angle: 0,
    fill: 1,
  });

  it('median averages middle pair for even length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
  });

  it('anchoredFamilies groups by log-size tolerance, largest first', () => {
    const comps = [comp(1, 10, 5), comp(2, 10.5, 5.2), comp(3, 30, 15), comp(4, 9.8, 4.9)];
    const fams = anchoredFamilies(comps, Math.log(1.2));
    expect(fams[0].map((c) => c.label)).toEqual([1, 2, 4]);
    expect(fams.some((f) => f.length === 1 && f[0].label === 3)).toBe(true);
  });
});
