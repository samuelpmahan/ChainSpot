import { describe, expect, test } from 'vitest';
import { cropRaster, type GrayRaster } from '@chainspot/alg';

const raster: GrayRaster = {
	widthPx: 4,
	heightPx: 3,
	gray: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
};

describe('cropRaster', () => {
	test('keeps exactly the requested rectangle of source pixels', () => {
		expect(cropRaster(raster, { top: 1, right: 1, bottom: 1, left: 1 })).toEqual({
			widthPx: 2,
			heightPx: 1,
			gray: Uint8Array.from([5, 6])
		});
	});

	test('rejects an inset that would leave no pixels', () => {
		expect(() => cropRaster(raster, { top: 3, right: 0, bottom: 0, left: 0 })).toThrow(
			'insets exceed raster size'
		);
	});
});
