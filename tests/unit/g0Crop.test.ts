import { describe, expect, test } from 'vitest';
import { applyCrop } from '@chainspot/alg/g0/crop';
import type { GrayRaster } from '@chainspot/alg';

function screenshotLikeRaster(tileNumber: number, widthPx = 24, heightPx = 20): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			const isSharedChrome = y < 3 || y >= heightPx - 2;
			gray[y * widthPx + x] = isSharedChrome ? 40 + y : (tileNumber * 97 + x * 11 + y * 7) % 256;
		}
	}
	return { widthPx, heightPx, gray };
}

describe('applyCrop', () => {
	test('crops rasters AND shifts placements by the same insets (the load-bearing part)', () => {
		const rasters = [screenshotLikeRaster(0), screenshotLikeRaster(1)];
		const placements = [
			{ x: 0, y: 0 },
			{ x: 144, y: 0 }
		];

		const result = applyCrop(rasters, placements);

		expect(result.insets).toEqual({ top: 3, right: 0, bottom: 2, left: 0 });
		expect(result.rasters[0].heightPx).toBe(15); // 20 - 3 - 2
		expect(result.rasters[0].widthPx).toBe(24); // no left/right inset
		// placements shift by (left, top) — here left=0 so x is unchanged, y shifts by top=3
		expect(result.placements).toEqual([
			{ x: 0, y: 3 },
			{ x: 144, y: 3 }
		]);
	});

	test('no proposal -> rasters and placements pass through unchanged (same references)', () => {
		const rasters = [screenshotLikeRaster(0)];
		const placements = [{ x: 0, y: 0 }];

		// a single raster never proposes a crop (proposeSharedCrop needs >=2)
		const result = applyCrop(rasters, placements);

		expect(result.insets).toBeNull();
		expect(result.rasters).toBe(rasters);
		expect(result.placements).toBe(placements);
	});

	test('skip option forces a pass-through even with a valid proposal available', () => {
		const rasters = [screenshotLikeRaster(0), screenshotLikeRaster(1)];
		const placements = [
			{ x: 0, y: 0 },
			{ x: 24, y: 0 }
		];

		const result = applyCrop(rasters, placements, { skip: true });

		expect(result.insets).toBeNull();
		expect(result.rasters).toBe(rasters);
		expect(result.placements).toBe(placements);
	});
});
