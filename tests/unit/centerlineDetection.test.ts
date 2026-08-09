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
	// Real-fixture regression coverage for the argmax-vs-icon-edge bug this
	// function was fixed for lives in `npm run detect:centerlines` against
	// `resources/GoldenTeeSet.chainspot.zip` / `GoldenBasketSet.chainspot.zip`
	// (verified to recover c1RadiusPx=92, matching the validated Python probe);
	// reproducing that photographic edge behavior deterministically from a
	// synthetic raster proved too fragile to be a useful unit test.

	it('finds a clean single ring and derives C2 as exactly double C1', () => {
		const widthPx = 200;
		const heightPx = 200;
		const basket = { xPx: 100, yPx: 100 };
		const raster = grayCircleRaster(widthPx, heightPx, [{ cx: basket.xPx, cy: basket.yPx, radiusPx: 60, thicknessPx: 4 }]);

		const { c1RadiusPx, c2RadiusPx } = detectPuttingCircleRadii(raster, [basket], { c1RangeLowPx: 20, c1RangeHighPx: 90 });

		expect(c1RadiusPx).toBeGreaterThanOrEqual(58);
		expect(c1RadiusPx).toBeLessThanOrEqual(62);
		expect(c2RadiusPx).toBe(c1RadiusPx * 2);
	});

	it('uses the median across baskets so one basket with no nearby ring does not skew the result', () => {
		const widthPx = 400;
		const heightPx = 200;
		const ringRadiusPx = 60;
		const agreeingBaskets = [
			{ xPx: 100, yPx: 100 },
			{ xPx: 200, yPx: 100 },
			{ xPx: 300, yPx: 100 }
		];
		const outlierBasket = { xPx: 380, yPx: 20 }; // near the raster edge; no ring around it
		const raster = grayCircleRaster(
			widthPx,
			heightPx,
			agreeingBaskets.map((basket) => ({ cx: basket.xPx, cy: basket.yPx, radiusPx: ringRadiusPx, thicknessPx: 4 }))
		);

		const { c1RadiusPx } = detectPuttingCircleRadii(raster, [...agreeingBaskets, outlierBasket], {
			c1RangeLowPx: 20,
			c1RangeHighPx: 90
		});

		expect(c1RadiusPx).toBeGreaterThanOrEqual(58);
		expect(c1RadiusPx).toBeLessThanOrEqual(62);
	});

	it('rejects an invalid search range', () => {
		const raster = grayCircleRaster(50, 50, []);
		expect(() => detectPuttingCircleRadii(raster, [{ xPx: 25, yPx: 25 }], { c1RangeLowPx: 40, c1RangeHighPx: 20 })).toThrow(
			/c1RangeHighPx/
		);
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
