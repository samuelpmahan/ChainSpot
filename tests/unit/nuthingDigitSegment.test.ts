import { describe, expect, it } from 'vitest';
import { segmentDigits } from '../../src/lib/nuthing/digits/segment';
import { extractComponents } from '../../src/lib/nuthing/components';
import type { Mask } from '../../src/lib/nuthing/raster';

function maskFromRows(rows: string[]): Mask {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = rows[y][x] === '#' ? 1 : 0;
    }
  }
  return { width, height, data };
}

describe('segmentDigits', () => {
  it('separates two non-touching blobs into two digits ordered left-to-right', () => {
    // Two 3x6 tall blobs with a clear gap between them.
    const rows = [
      '###....###',
      '###....###',
      '###....###',
      '###....###',
      '###....###',
      '###....###',
    ];
    const mask = maskFromRows(rows);
    const result = segmentDigits(mask);
    expect(result.digits).toHaveLength(2);
    expect(result.digits.every((d) => d.method === 'cc')).toBe(true);
    // Ordered left to right by bbox x.
    expect(result.digits[0].bbox[0]).toBeLessThan(result.digits[1].bbox[0]);
    expect(result.digits[0].bbox).toEqual([0, 0, 3, 6]);
    expect(result.digits[1].bbox).toEqual([7, 0, 3, 6]);
  });

  it('drops a speck below the noise threshold', () => {
    // One real digit-shaped blob (tall, area 18) plus an isolated 2px
    // vertical speck (area 2, height 2) far to the right.
    const rows = [
      '###.......',
      '###.......',
      '###.......',
      '###.......',
      '###.......',
      '###....#..',
      '.......#..',
    ];
    const mask = maskFromRows(rows);
    const result = segmentDigits(mask);
    expect(result.digits).toHaveLength(1);
    expect(result.digits[0].bbox).toEqual([0, 0, 3, 6]);
    expect(result.notes.some((n) => n.includes('noise'))).toBe(true);
  });

  it('keeps a narrow "1"-like blob as its own digit', () => {
    // A normal digit-shaped blob (3 wide, 7 tall) plus a genuinely narrow
    // '1' stroke (1 wide, 7 tall) at the same height, well separated.
    const rows = [
      '###....#..',
      '###....#..',
      '###....#..',
      '###....#..',
      '###....#..',
      '###....#..',
      '###....#..',
    ];
    const mask = maskFromRows(rows);
    const result = segmentDigits(mask);
    expect(result.digits).toHaveLength(2);
    const narrow = result.digits.find((d) => d.bbox[2] === 1);
    expect(narrow).toBeDefined();
    expect(narrow!.bbox[3]).toBe(7);
    expect(narrow!.method).toBe('cc');
  });

  it('splits a wide merged blob into two via valley-split', () => {
    // One 8-connected component: two 4x6 solid blocks joined only by a
    // single-pixel bridge at their shared row (col 4, row 2). Overall
    // bbox is 9 wide x 6 tall (w > 0.95*h), so it is a merge candidate;
    // the bridge column has the lowest column-sum (1 vs 6), landing the
    // valley search squarely on it.
    const rows = [
      '####.####',
      '####.####',
      '#########',
      '####.####',
      '####.####',
      '####.####',
    ];
    const mask = maskFromRows(rows);
    // Sanity: single connected component before segmentation splits it.
    const components = extractComponents(mask).components;
    expect(components).toHaveLength(1);
    expect(components[0].bboxW).toBe(9);
    expect(components[0].bboxH).toBe(6);

    const result = segmentDigits(mask);
    expect(result.digits).toHaveLength(2);
    expect(result.digits.every((d) => d.method === 'valley-split')).toBe(true);
    expect(result.digits[0].bbox[0]).toBeLessThan(result.digits[1].bbox[0]);
  });
});
