import { describe, expect, test } from 'vitest';
import { toGrayRaster } from '@chainspot/alg/g0/inputAsset';

describe('toGrayRaster', () => {
	test('applies integer Rec.601 luma per pixel, matching src/lib/raster.ts', () => {
		// two pixels: pure white and pure black
		const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
		const result = toGrayRaster({ widthPx: 2, heightPx: 1, rgba });

		expect(result.widthPx).toBe(2);
		expect(result.heightPx).toBe(1);
		// (255*77 + 255*150 + 255*29) >> 8 = 255
		expect(result.gray[0]).toBe(255);
		expect(result.gray[1]).toBe(0);
	});

	test('a known RGB triple matches the exact >>8 integer formula', () => {
		const rgba = new Uint8ClampedArray([100, 150, 200, 255]);
		const expected = (100 * 77 + 150 * 150 + 200 * 29) >> 8;
		const result = toGrayRaster({ widthPx: 1, heightPx: 1, rgba });
		expect(result.gray[0]).toBe(expected);
	});
});
