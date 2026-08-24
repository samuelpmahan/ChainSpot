import { describe, expect, test } from 'vitest';
import { materializeComposite, compositeIdBytes } from '@chainspot/alg/g0/composite';

describe('materializeComposite', () => {
	test('single tile, no crop: passthrough pixels, deterministic pinned imageId', async () => {
		// 2x1 RGBA: pixel0 = (10,20,30,255), pixel1 = (40,50,60,255).
		// Expected hash independently computed with node:crypto over
		// sha256([u32be 2][u32be 1][the 8 rgba bytes below]) — see
		// g0/composite.ts's documented byte definition. Pinning this catches
		// any accidental drift in byte order, dimension order, or hashed
		// content across platforms.
		const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
		const result = await materializeComposite([{ rgba, widthPx: 2, heightPx: 1, placement: { x: 0, y: 0 } }]);

		expect(result.widthPx).toBe(2);
		expect(result.heightPx).toBe(1);
		expect(Array.from(result.rgba)).toEqual(Array.from(rgba));
		expect(result.imageId).toBe('810f1471aaa0b7a2e904ac1a916e091f74dc007c52d3efeacb3d76bae5177e6d');
	});

	test('compositeIdBytes lays out [u32be width][u32be height][rgba] big-endian', () => {
		const rgba = new Uint8ClampedArray([1, 2, 3, 4]);
		const bytes = compositeIdBytes(0x00000002, 0x00000001, rgba);
		expect(Array.from(bytes)).toEqual([0, 0, 0, 2, 0, 0, 0, 1, 1, 2, 3, 4]);
	});

	test('two tiles placed side by side flatten into one wider composite, cropped by insets', async () => {
		// each ORIGINAL tile is 4x2; insets crop 1px off the left and right,
		// leaving a 2x2 cropped region per tile, placed at x=0 and x=2
		const left = new Uint8ClampedArray(4 * 2 * 4);
		const right = new Uint8ClampedArray(4 * 2 * 4);
		for (let i = 0; i < 4 * 2; i++) {
			left.set([1, 1, 1, 255], i * 4);
			right.set([2, 2, 2, 255], i * 4);
		}
		const insets = { top: 0, right: 1, bottom: 0, left: 1 };

		const result = await materializeComposite(
			[
				{ rgba: left, widthPx: 4, heightPx: 2, placement: { x: 0, y: 0 } },
				{ rgba: right, widthPx: 4, heightPx: 2, placement: { x: 2, y: 0 } }
			],
			insets
		);

		expect(result.widthPx).toBe(4);
		expect(result.heightPx).toBe(2);
		// left half is tile "left"'s color, right half is tile "right"'s color
		expect(Array.from(result.rgba.slice(0, 4))).toEqual([1, 1, 1, 255]);
		expect(Array.from(result.rgba.slice(8, 12))).toEqual([2, 2, 2, 255]);
	});

	test('rejects tiles that crop to inconsistent sizes', async () => {
		const a = new Uint8ClampedArray(4 * 4 * 4);
		const b = new Uint8ClampedArray(6 * 4 * 4);
		await expect(
			materializeComposite([
				{ rgba: a, widthPx: 4, heightPx: 4, placement: { x: 0, y: 0 } },
				{ rgba: b, widthPx: 6, heightPx: 4, placement: { x: 4, y: 0 } }
			])
		).rejects.toThrow();
	});

	test('rejects an empty tile list', async () => {
		await expect(materializeComposite([])).rejects.toThrow();
	});
});
