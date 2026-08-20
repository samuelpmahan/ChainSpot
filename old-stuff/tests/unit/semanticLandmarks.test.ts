import { describe, expect, test } from 'vitest';
import { detectSemanticLandmarkBatch, type SemanticRaster } from '../../src/lib/stitch/semanticLandmarks';

function raster(sourceId: string, widthPx = 320, heightPx = 220): { raster: SemanticRaster; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let i = 0; i < widthPx * heightPx; i += 1) {
    const o = i * 4;
    data[o] = 110;
    data[o + 1] = 110;
    data[o + 2] = 110;
    data[o + 3] = 255;
  }
  return { raster: { sourceId, rgba: data, widthPx, heightPx }, data };
}

function rect(data: Uint8ClampedArray, width: number, x: number, y: number, w: number, h: number, v: number): void {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) {
    const o = (yy * width + xx) * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
}

function basket(data: Uint8ClampedArray, width: number, x: number, y: number): void {
  rect(data, width, x, y, 20, 6, 245);
  rect(data, width, x + 7, y + 5, 6, 27, 245);
}

function populate(data: Uint8ClampedArray, width: number, origins: readonly [number, number][]): void {
  for (const [x, y] of origins) {
    rect(data, width, x, y, 48, 36, 20);
    basket(data, width, x + 80, y + 2);
  }
}

describe('semantic stitch landmarks', () => {
  test('learns badge/basket family geometry across the batch so a one-landmark source can participate', () => {
    const a = raster('a');
    const b = raster('b');
    populate(a.data, 320, [[20, 20], [20, 90], [180, 90]]);
    populate(b.data, 320, [[40, 60]]);

    const result = detectSemanticLandmarkBatch([a.raster, b.raster]);

    expect(result.scales.badge?.widthPx).toBe(48);
    expect(result.scales.badge?.heightPx).toBe(36);
    expect(result.scales.basket?.widthPx).toBe(20);
    expect(result.scales.basket?.heightPx).toBe(32);
    expect(result.sources[0].landmarks.filter((x) => x.family === 'badge')).toHaveLength(3);
    expect(result.sources[1].landmarks.filter((x) => x.family === 'badge')).toHaveLength(1);
    expect(result.sources[1].landmarks.filter((x) => x.family === 'basket')).toHaveLength(1);
    expect(result.diagnostics.badgeAbstention).toBeNull();
    expect(result.diagnostics.basketAbstention).toBeNull();
  });

  test('abstains instead of inventing a family when the whole batch has only one candidate', () => {
    const only = raster('only');
    populate(only.data, 320, [[40, 60]]);
    const result = detectSemanticLandmarkBatch([only.raster]);
    expect(result.sources[0].landmarks).toEqual([]);
    expect(result.diagnostics.badgeAbstention).toBe('insufficient-batch-consensus');
    expect(result.diagnostics.basketAbstention).toBe('insufficient-batch-consensus');
  });
});
