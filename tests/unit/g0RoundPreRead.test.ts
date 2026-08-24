import { describe, expect, test } from 'vitest';
import { preReadRound } from '@chainspot/alg/g0/roundPreRead';
import type { RgbaRaster } from '@chainspot/alg/detect';

describe('preReadRound', () => {
	test('an image with no walk/droplet color mass resolves to an empty, valid pre-read', async () => {
		const widthPx = 20;
		const heightPx = 20;
		const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
		for (let i = 0; i < rgba.length; i += 4) rgba.set([200, 200, 200, 255], i); // flat gray, no purple/blue

		const result = await preReadRound({ imageId: 'x', widthPx, heightPx, rgba });

		expect(result).toEqual({ walk: [], droplets: [] });
	});

	test('a detector failure never throws — resolves to the same empty, valid pre-read', async () => {
		// malformed on purpose: rgba length does not match widthPx*heightPx*4,
		// which both traceWalk and findDroplets reject by throwing
		const malformed: RgbaRaster = {
			imageId: 'x',
			widthPx: 10,
			heightPx: 10,
			rgba: new Uint8ClampedArray(4) // far too short
		};

		await expect(preReadRound(malformed)).resolves.toEqual({ walk: [], droplets: [] });
	});
});
