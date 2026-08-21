import { describe, expect, it } from 'vitest';
import type { DetectorEmission, RgbaRaster } from '$lib/detect';
import { labEndpointDetector } from '$lib/detectors/labEndpoint';

function raster(widthPx: number, heightPx: number): RgbaRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i++) rgba[i * 4 + 3] = 255;
	return { imageId: 'synthetic', widthPx, heightPx, rgba };
}

function white(image: RgbaRaster, x: number, y: number): void {
	const offset = (y * image.widthPx + x) * 4;
	image.rgba[offset] = 255;
	image.rgba[offset + 1] = 255;
	image.rgba[offset + 2] = 255;
}

function outline(
	image: RgbaRaster,
	x0: number,
	y0: number,
	width: number,
	height: number,
	thickness = 3
): void {
	for (let y = y0; y < y0 + height; y++) {
		for (let x = x0; x < x0 + width; x++) {
			if (
				x < x0 + thickness ||
				x >= x0 + width - thickness ||
				y < y0 + thickness ||
				y >= y0 + height - thickness
			) {
				white(image, x, y);
			}
		}
	}
}

async function detect(image: RgbaRaster): Promise<DetectorEmission[]> {
	const emissions: DetectorEmission[] = [];
	await labEndpointDetector(image, (emission) => emissions.push(emission));
	return emissions;
}

describe('labEndpointDetector', () => {
	it('emits a square hollow marker as a tee', async () => {
		const image = raster(96, 96);
		outline(image, 35, 35, 24, 24);

		const emissions = await detect(image);
		const tees = emissions.filter(
			(emission) => emission.kind === 'object' && emission.objType === 'tee'
		);

		expect(tees).toHaveLength(1);
		expect(tees[0]).toMatchObject({ imageId: 'synthetic', detId: 'tee-0' });
	});

	it('emits a basket at the sprite pole tip', async () => {
		const image = raster(100, 100);
		const sprite = (await import('$lib/detectors/labEndpoint/assets/basket-sprite.json')).default;
		const x0 = 20;
		const y0 = 10;
		for (let y = 0; y < sprite.height; y++) {
			for (let x = 0; x < sprite.width; x++)
				if (sprite.rows[y][x] === '1') white(image, x0 + x, y0 + y);
		}

		const emissions = await detect(image);
		const baskets = emissions.filter(
			(emission) => emission.kind === 'object' && emission.objType === 'basket'
		);

		expect(baskets).toContainEqual(
			expect.objectContaining({ xPx: x0 + sprite.width / 2, yPx: y0 + sprite.height + 4 })
		);
	});

	it('is deterministic', async () => {
		const image = raster(80, 80);
		outline(image, 20, 25, 30, 20);

		expect(await detect(image)).toEqual(await detect(image));
	});

	it('rejects malformed raster input', async () => {
		const malformed = { ...raster(10, 10), rgba: new Uint8ClampedArray(3) };
		await expect(detect(malformed)).rejects.toThrow('RGBA byte length');
	});
});
