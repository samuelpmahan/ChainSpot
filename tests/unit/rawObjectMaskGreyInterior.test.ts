import { describe, expect, it } from 'vitest';
import { hasGreyInterior } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { RawObjectMaskRaster } from '../../src/lib/autoAnnotation/rawObjectMask';

/** A solid-color raster, one candidate bounding box can be painted a different color inside it. */
function solidRaster(widthPx: number, heightPx: number, rgb: [number, number, number]): RawObjectMaskRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i += 1) {
		rgba[i * 4] = rgb[0];
		rgba[i * 4 + 1] = rgb[1];
		rgba[i * 4 + 2] = rgb[2];
		rgba[i * 4 + 3] = 255;
	}
	return { rgba, widthPx, heightPx };
}

function paintRect(
	raster: RawObjectMaskRaster,
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	rgb: [number, number, number]
): void {
	const rgba = raster.rgba as Uint8ClampedArray;
	for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
		for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
			const offset = (y * raster.widthPx + x) * 4;
			rgba[offset] = rgb[0];
			rgba[offset + 1] = rgb[1];
			rgba[offset + 2] = rgb[2];
			rgba[offset + 3] = 255;
		}
	}
}

const BOUNDS = { minX: 10, minY: 10, maxX: 39, maxY: 39 }; // 30x30

describe('hasGreyInterior', () => {
	it('rejects a candidate that is uniformly bright with no grey pixels at all', () => {
		// A rooftop-like false positive: bright and white throughout, no interior variation.
		const raster = solidRaster(60, 60, [40, 90, 40]); // green fairway background
		paintRect(raster, BOUNDS, [235, 232, 225]); // uniformly bright/white interior, no breaks

		expect(hasGreyInterior(raster, BOUNDS)).toBe(false);
	});

	it('accepts a candidate whose interior has a genuine grey patch, even a small one', () => {
		const raster = solidRaster(60, 60, [40, 90, 40]);
		paintRect(raster, BOUNDS, [235, 232, 225]); // bright frame
		// A small grey pad-like patch inside -- moderate value, low saturation.
		paintRect(raster, { minX: 18, minY: 18, maxX: 25, maxY: 25 }, [158, 158, 158]);

		expect(hasGreyInterior(raster, BOUNDS)).toBe(true);
	});

	it('accepts a candidate that is mostly grey (typical real tee pad interior)', () => {
		const raster = solidRaster(60, 60, [40, 90, 40]);
		paintRect(raster, BOUNDS, [158, 158, 158]);

		expect(hasGreyInterior(raster, BOUNDS)).toBe(true);
	});

	it('rejects a candidate that is uniformly dark with no grey pixels (a shadow, not a pad)', () => {
		const raster = solidRaster(60, 60, [40, 90, 40]);
		paintRect(raster, BOUNDS, [10, 10, 12]);

		expect(hasGreyInterior(raster, BOUNDS)).toBe(false);
	});

	it('rejects a candidate whose non-bright pixels are vividly colored, not grey', () => {
		// Low-brightness-but-high-saturation content (e.g. a colored map icon
		// fragment) is not a grey pad interior either.
		const raster = solidRaster(60, 60, [40, 90, 40]);
		paintRect(raster, BOUNDS, [235, 232, 225]);
		paintRect(raster, { minX: 18, minY: 18, maxX: 25, maxY: 25 }, [200, 30, 30]); // saturated red, not grey
		expect(hasGreyInterior(raster, BOUNDS)).toBe(false);
	});
});
