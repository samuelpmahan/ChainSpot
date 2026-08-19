import { describe, expect, it } from 'vitest';
import { DIGIT_W, DIGIT_H } from '../../src/lib/nuthing/digits/normalize';
import {
  occupancy6x8,
  occupancy8x10,
  occupancy12x16,
  multiscale,
  rowProjection32,
  colProjection24,
  fullMask768,
  topology,
  aspect,
} from '../../src/lib/nuthing/digits/features';

/** All-zero 24x32 mask. */
function emptyMask(): Uint8Array {
  return new Uint8Array(DIGIT_W * DIGIT_H);
}

/** All-one 24x32 mask. */
function fullMask(): Uint8Array {
  return new Uint8Array(DIGIT_W * DIGIT_H).fill(1);
}

/** Fill an axis-aligned rectangle [x, y, w, h] with 1s in-place. */
function fillRect(mask: Uint8Array, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      mask[yy * DIGIT_W + xx] = 1;
    }
  }
}

describe('occupancy grids: sum/range sanity', () => {
  it('occupancy6x8 is all zero on an empty mask', () => {
    const grid = occupancy6x8(emptyMask());
    expect(grid).toHaveLength(48);
    expect(grid.every((v) => v === 0)).toBe(true);
  });

  it('occupancy6x8 is all one on a fully-set mask (4x4 cells divide evenly)', () => {
    const grid = occupancy6x8(fullMask());
    expect(grid).toHaveLength(48);
    expect(grid.every((v) => v === 1)).toBe(true);
  });

  it('occupancy6x8 values stay within [0, 1] and match a known half-filled cell', () => {
    const mask = emptyMask();
    // Top-left 4x4 cell (cols 0-3, rows 0-7 -> cell (0,0) covers rows 0-3):
    // set exactly 2 of its 16 pixels.
    mask[0 * DIGIT_W + 0] = 1;
    mask[0 * DIGIT_W + 1] = 1;
    const grid = occupancy6x8(mask);
    for (const v of grid) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(grid[0]).toBeCloseTo(2 / 16, 10);
    // Every other cell is untouched.
    expect(grid.filter((v) => v > 0)).toHaveLength(1);
  });

  it('occupancy8x10 partitions 32 rows into cell heights summing to 32, all cells in range', () => {
    const grid = occupancy8x10(fullMask());
    expect(grid).toHaveLength(80);
    expect(grid.every((v) => v === 1)).toBe(true); // fully-set mask -> every cell fully occupied regardless of cell size
    const empty = occupancy8x10(emptyMask());
    expect(empty.every((v) => v === 0)).toBe(true);
  });

  it('occupancy12x16 is all zero/one consistently with the other grids', () => {
    expect(occupancy12x16(emptyMask()).every((v) => v === 0)).toBe(true);
    expect(occupancy12x16(fullMask())).toHaveLength(192);
    expect(occupancy12x16(fullMask()).every((v) => v === 1)).toBe(true);
  });

  it('multiscale concatenates occupancy6x8 and occupancy12x16 (48 + 192 = 240 dims)', () => {
    const mask = emptyMask();
    fillRect(mask, 0, 0, 4, 4);
    const combined = multiscale(mask);
    expect(combined).toHaveLength(240);
    expect(combined.slice(0, 48)).toEqual(occupancy6x8(mask));
    expect(combined.slice(48)).toEqual(occupancy12x16(mask));
  });
});

describe('projections: normalization', () => {
  it('rowProjection32 is normalized by row length (24) and in [0, 1]', () => {
    const mask = emptyMask();
    // Row 5: set 6 of 24 pixels.
    for (let x = 0; x < 6; x++) mask[5 * DIGIT_W + x] = 1;
    const proj = rowProjection32(mask);
    expect(proj).toHaveLength(DIGIT_H);
    expect(proj[5]).toBeCloseTo(6 / 24, 10);
    for (const v of proj) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(rowProjection32(fullMask()).every((v) => v === 1)).toBe(true);
    expect(rowProjection32(emptyMask()).every((v) => v === 0)).toBe(true);
  });

  it('colProjection24 is normalized by column length (32) and in [0, 1]', () => {
    const mask = emptyMask();
    // Col 3: set 8 of 32 pixels.
    for (let y = 0; y < 8; y++) mask[y * DIGIT_W + 3] = 1;
    const proj = colProjection24(mask);
    expect(proj).toHaveLength(DIGIT_W);
    expect(proj[3]).toBeCloseTo(8 / 32, 10);
    for (const v of proj) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(colProjection24(fullMask()).every((v) => v === 1)).toBe(true);
    expect(colProjection24(emptyMask()).every((v) => v === 0)).toBe(true);
  });
});

describe('fullMask768', () => {
  it('returns the 768 pixels unchanged as 0/1', () => {
    const mask = emptyMask();
    mask[0] = 1;
    mask[767] = 1;
    const out = fullMask768(mask);
    expect(out).toHaveLength(768);
    expect(out[0]).toBe(1);
    expect(out[767]).toBe(1);
    expect(out.filter((v) => v === 1)).toHaveLength(2);
  });
});

describe('aspect', () => {
  it('computes rawWidth / rawHeight, 0 for degenerate height', () => {
    expect(aspect(7, 21)).toBeCloseTo(7 / 21, 10);
    expect(aspect(10, 0)).toBe(0);
  });
});

describe('topology: hole detection via border flood fill', () => {
  it('a solid bar ("1"-like) has zero holes', () => {
    const mask = emptyMask();
    // Narrow solid vertical bar, well inside the canvas.
    fillRect(mask, 10, 4, 4, 24);
    const t = topology(mask);
    expect(t.holeCount).toBe(0);
    expect(t.holeSizeFractions).toEqual([]);
    expect(t.strokeFraction).toBeCloseTo((4 * 24) / (DIGIT_W * DIGIT_H), 10);
  });

  it('an empty mask has zero holes and zero stroke fraction', () => {
    const t = topology(emptyMask());
    expect(t.holeCount).toBe(0);
    expect(t.strokeFraction).toBe(0);
  });

  it('a fully-set mask has zero holes (no background at all) and stroke fraction 1', () => {
    const t = topology(fullMask());
    expect(t.holeCount).toBe(0);
    expect(t.strokeFraction).toBe(1);
  });

  it('a single hollow rectangle ("0"-like) has exactly one hole', () => {
    const mask = emptyMask();
    fillRect(mask, 4, 2, 16, 28);
    // Clear a strictly interior region so it never touches the mask border
    // (must stay fully enclosed by the stroke on all four sides).
    for (let y = 5; y < 27; y++) {
      for (let x = 7; x < 17; x++) mask[y * DIGIT_W + x] = 0;
    }
    const t = topology(mask);
    expect(t.holeCount).toBe(1);
    expect(t.holeSizeFractions).toHaveLength(1);
    expect(t.holeSizeFractions[0]).toBeCloseTo((22 * 10) / (DIGIT_W * DIGIT_H), 10);
  });

  it('two stacked hollow rectangles ("8"-like ring pair) have exactly two holes', () => {
    const mask = emptyMask();
    // Top ring: outer 4..19 x 1..14, inner clear 7..16 x 3..12.
    fillRect(mask, 4, 1, 16, 13);
    for (let y = 3; y < 12; y++) {
      for (let x = 7; x < 17; x++) mask[y * DIGIT_W + x] = 0;
    }
    // Bottom ring: outer 4..19 x 17..30, inner clear 7..16 x 19..28.
    fillRect(mask, 4, 17, 16, 13);
    for (let y = 19; y < 28; y++) {
      for (let x = 7; x < 17; x++) mask[y * DIGIT_W + x] = 0;
    }
    const t = topology(mask);
    expect(t.holeCount).toBe(2);
    expect(t.holeSizeFractions).toHaveLength(2);
    // Sorted largest-first; both rings have identical interior size here.
    expect(t.holeSizeFractions[0]).toBeCloseTo(t.holeSizeFractions[1], 10);
  });
});
