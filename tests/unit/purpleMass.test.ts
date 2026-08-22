import { describe, expect, it } from 'vitest';
import type { DetectorEmission, RgbaRaster } from '$lib/detect';
import { measurePurpleMass, purpleMassDetector } from '$lib/detectors/purpleMass';

function raster(widthPx = 200, heightPx = 200): RgbaRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i + 1] = 180;
		rgba[i + 3] = 255;
	}
	return { imageId: 'synthetic', widthPx, heightPx, rgba };
}

function setPurple(image: RgbaRaster, count: number): void {
	// 200x200 samples every second pixel. Keep coordinates even so every mark is sampled.
	for (let i = 0; i < count; i++) {
		const x = (i % 100) * 2;
		const y = Math.floor(i / 100) * 2;
		const p = (y * image.widthPx + x) * 4;
		image.rgba[p] = 85;
		image.rgba[p + 1] = 0;
		image.rgba[p + 2] = 255;
	}
}

describe('purple path mass', () => {
	it('separates map, uncertain, and likely-thrown purple fractions', () => {
		const map = raster();
		expect(measurePurpleMass(map).intent).toBe('likely-map');

		const uncertain = raster();
		setPurple(uncertain, 20);
		expect(measurePurpleMass(uncertain).intent).toBe('uncertain');

		const thrown = raster();
		setPurple(thrown, 60);
		const measured = measurePurpleMass(thrown);
		expect(measured.intent).toBe('likely-thrown');
		expect(measured.fraction).toBeCloseTo(0.006);
		expect(measured.confidence).toBe(measured.fraction);
	});

	it('emits comparable thrown-round classifications for every image', async () => {
		const mapEvents: DetectorEmission[] = [];
		await purpleMassDetector(raster(), (event) => mapEvents.push(event));
		expect(mapEvents).toHaveLength(1);
		expect(mapEvents[0]).toMatchObject({
			kind: 'classification',
			trait: 'thrown-round',
			confidence: 0
		});

		const thrown = raster();
		setPurple(thrown, 60);
		const thrownEvents: DetectorEmission[] = [];
		await purpleMassDetector(thrown, (event) => thrownEvents.push(event));
		expect(thrownEvents).toHaveLength(1);
		expect(thrownEvents[0]).toMatchObject({ kind: 'classification', trait: 'thrown-round' });
		expect(thrownEvents[0].confidence).toBeGreaterThan(mapEvents[0].confidence);
	});

	it('rejects a malformed raster instead of silently scoring it', () => {
		expect(() =>
			measurePurpleMass({ imageId: 'bad', widthPx: 2, heightPx: 2, rgba: new Uint8ClampedArray(3) })
		).toThrow(/byte length/);
	});
});
