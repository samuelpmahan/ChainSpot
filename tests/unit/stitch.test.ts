import { describe, expect, test } from 'vitest';
import { findBestTranslation } from '$lib/stitch';
import type { GrayRaster } from '$lib/raster';

function worldPixel(x: number, y: number): number {
	return ((x * 73) ^ (y * 151) ^ (x * y * 29)) & 255;
}

function rasterFromWorld(originX: number, originY: number, widthPx = 32, heightPx = 28): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			gray[y * widthPx + x] = worldPixel(originX + x, originY + y);
		}
	}
	return { widthPx, heightPx, gray };
}

describe('findBestTranslation', () => {
	test('recovers the known position of tile B relative to tile A', () => {
		const tileA = rasterFromWorld(100, 100);
		const tileB = rasterFromWorld(109, 94);

		expect(findBestTranslation(tileA, tileB)).toEqual({ dx: 9, dy: -6, score: 0 });
	});
});
