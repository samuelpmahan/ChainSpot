import { describe, expect, it } from 'vitest';
import {
	buildOcclusionMask,
	computeOverlayFeature,
	detectPuttingCircleRadii,
	rectangleExitPoint
} from '../../src/lib/autoAnnotation/centerlineDetection';
import type { CenterlineNumberBadge, CenterlineRaster } from '../../src/lib/autoAnnotation/centerlineDetection';

function grayCircleRaster(
	widthPx: number,
	heightPx: number,
	rings: readonly { readonly cx: number; readonly cy: number; readonly radiusPx: number; readonly thicknessPx: number }[]
): CenterlineRaster {
	const gray = new Uint8Array(widthPx * heightPx).fill(30);
	for (const ring of rings) {
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				const distance = Math.hypot(x - ring.cx, y - ring.cy);
				if (Math.abs(distance - ring.radiusPx) <= ring.thicknessPx / 2) gray[y * widthPx + x] = 220;
			}
		}
	}
	const rgba = new Uint8Array(widthPx * heightPx * 4);
	for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
		rgba[offset] = gray[pixel];
		rgba[offset + 1] = gray[pixel];
		rgba[offset + 2] = gray[pixel];
		rgba[offset + 3] = 255;
	}
	return { rgba, gray, widthPx, heightPx };
}

describe('detectPuttingCircleRadii', () => {
	// Real-fixture regression coverage lives in `npm run detect:centerlines`
	// against `resources/GoldenTeeSet.chainspot.zip` / `GoldenBasketSet.chainspot.zip`
	// (verified to recover c1RadiusPx=46/c2RadiusPx=92, matching the inner
	// solid / outer dashed rings visible on the source image itself).

	it('picks the ring pair at the true 1:2 ratio over a stronger single unpaired ring', () => {
		// The unpaired ring at radius 30 is a stronger single edge than either
		// ring in the true 30(no partner)-vs-46/92 pair, so a plain argmax over
		// the raw score curve would wrongly lock onto 30. Requiring a matching
		// edge at 2x the candidate radius is what selects the real C1/C2 pair.
		const widthPx = 250;
		const heightPx = 250;
		const basket = { xPx: 125, yPx: 125 };
		const raster = grayCircleRaster(widthPx, heightPx, [
			{ cx: basket.xPx, cy: basket.yPx, radiusPx: 30, thicknessPx: 4 },
			{ cx: basket.xPx, cy: basket.yPx, radiusPx: 46, thicknessPx: 3 },
			{ cx: basket.xPx, cy: basket.yPx, radiusPx: 92, thicknessPx: 3 }
		]);

		const { c1RadiusPx, c2RadiusPx } = detectPuttingCircleRadii(raster, [basket], { c1RangeLowPx: 20, c1RangeHighPx: 110 });

		expect(c1RadiusPx).toBeGreaterThanOrEqual(45);
		expect(c1RadiusPx).toBeLessThanOrEqual(47);
		expect(c2RadiusPx).toBe(c1RadiusPx * 2);
	});

	it('uses the median across baskets so one basket with no nearby rings does not skew the result', () => {
		const widthPx = 400;
		const heightPx = 250;
		const agreeingBaskets = [
			{ xPx: 100, yPx: 125 },
			{ xPx: 200, yPx: 125 },
			{ xPx: 300, yPx: 125 }
		];
		const outlierBasket = { xPx: 390, yPx: 10 }; // near the raster edge; no rings around it
		const raster = grayCircleRaster(
			widthPx,
			heightPx,
			agreeingBaskets.flatMap((basket) => [
				{ cx: basket.xPx, cy: basket.yPx, radiusPx: 46, thicknessPx: 3 },
				{ cx: basket.xPx, cy: basket.yPx, radiusPx: 92, thicknessPx: 3 }
			])
		);

		const { c1RadiusPx, c2RadiusPx } = detectPuttingCircleRadii(raster, [...agreeingBaskets, outlierBasket], {
			c1RangeLowPx: 20,
			c1RangeHighPx: 110
		});

		expect(c1RadiusPx).toBeGreaterThanOrEqual(45);
		expect(c1RadiusPx).toBeLessThanOrEqual(47);
		expect(c2RadiusPx).toBe(c1RadiusPx * 2);
	});

	it('rejects an invalid search range', () => {
		const raster = grayCircleRaster(50, 50, []);
		expect(() => detectPuttingCircleRadii(raster, [{ xPx: 25, yPx: 25 }], { c1RangeLowPx: 40, c1RangeHighPx: 20 })).toThrow(
			/c1RangeHighPx/
		);
	});

	it('rejects a range too narrow to fit any C1/C2 pair', () => {
		const raster = grayCircleRaster(50, 50, []);
		expect(() =>
			detectPuttingCircleRadii(raster, [{ xPx: 25, yPx: 25 }], { c1RangeLowPx: 20, c1RangeHighPx: 30 })
		).toThrow(/2 \* c1RangeLowPx/);
	});

	it('requires at least one basket point', () => {
		const raster = grayCircleRaster(50, 50, []);
		expect(() => detectPuttingCircleRadii(raster, [])).toThrow(/basket point/);
	});
});

describe('buildOcclusionMask', () => {
	it('marks number-badge, basket-halo, and tee regions as occluded and leaves everything else clear', () => {
		const widthPx = 200;
		const heightPx = 200;
		const badge: CenterlineNumberBadge = { xPx: 55, yPx: 55, leftPx: 50, topPx: 50, widthPx: 10, heightPx: 10 };
		const basket = { xPx: 150, yPx: 50 };
		const tee = { xPx: 50, yPx: 150 };
		const c2RadiusPx = 20;

		const mask = buildOcclusionMask(widthPx, heightPx, [badge], [basket], [tee], c2RadiusPx);

		// Inside the padded badge rectangle.
		expect(mask[55 * widthPx + 55]).toBe(255);
		// Inside the basket's C2+halo circle.
		expect(mask[basket.yPx * widthPx + basket.xPx]).toBe(255);
		expect(mask[basket.yPx * widthPx + (basket.xPx + c2RadiusPx + 9)]).toBe(255);
		expect(mask[basket.yPx * widthPx + (basket.xPx + c2RadiusPx + 20)]).toBe(0);
		// Inside the tee's fixed 12px circle.
		expect(mask[tee.yPx * widthPx + tee.xPx]).toBe(255);
		// Untouched open ground.
		expect(mask[10 * widthPx + 10]).toBe(0);
	});
});

describe('computeOverlayFeature', () => {
	it('produces one value per pixel', () => {
		const raster = grayCircleRaster(40, 30, []);
		const feature = computeOverlayFeature(raster);
		expect(feature).toHaveLength(40 * 30);
	});
});

describe('rectangleExitPoint', () => {
	it('finds where a ray from center to a point beyond the marker exits the padded rectangle', () => {
		const center = { xPx: 55, yPx: 55 };
		const marker: CenterlineNumberBadge = { xPx: 55, yPx: 55, leftPx: 50, topPx: 50, widthPx: 10, heightPx: 10 };
		const toward = { xPx: 100, yPx: 55 };

		const exit = rectangleExitPoint(center, toward, marker, 0);

		expect(exit.xPx).toBeCloseTo(60, 5);
		expect(exit.yPx).toBeCloseTo(55, 5);
	});

	it('pads the rectangle outward before finding the exit', () => {
		const center = { xPx: 55, yPx: 55 };
		const marker: CenterlineNumberBadge = { xPx: 55, yPx: 55, leftPx: 50, topPx: 50, widthPx: 10, heightPx: 10 };
		const toward = { xPx: 100, yPx: 55 };

		const exit = rectangleExitPoint(center, toward, marker, 8);

		expect(exit.xPx).toBeCloseTo(68, 5);
		expect(exit.yPx).toBeCloseTo(55, 5);
	});

	it('returns the center unchanged when toward is coincident with it', () => {
		const center = { xPx: 55, yPx: 55 };
		const marker: CenterlineNumberBadge = { xPx: 55, yPx: 55, leftPx: 50, topPx: 50, widthPx: 10, heightPx: 10 };
		expect(rectangleExitPoint(center, center, marker)).toEqual(center);
	});
});
