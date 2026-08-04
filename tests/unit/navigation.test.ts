import { describe, expect, it } from 'vitest';
import {
	ABSOLUTE_MAX_VIEW_ZOOM,
	ABSOLUTE_MIN_VIEW_ZOOM,
	DEFAULT_VIEW_ZOOM_LIMITS,
	WHEEL_ZOOM_STEP_DELTA,
	clampViewZoom,
	defaultFitTransform,
	panBy,
	resizeViewTransform,
	wheelZoomFactor,
	zoomAtPointer,
	zoomLimitsForFit
} from '../../src/lib/navigation';
import { ROUND_TRIP_TOLERANCE, fitViewTransform, imageToScreen, screenToImage } from '../../src/lib/coords';
import type { ImageSpacePoint, ScreenSpacePoint, ViewTransformState } from '../../src/lib/coords';

function expectImagePointClose(actual: ImageSpacePoint, expected: ImageSpacePoint): void {
	expect(Math.abs(actual.xPx - expected.xPx)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE);
	expect(Math.abs(actual.yPx - expected.yPx)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE);
}

/** Asserts the image-space location under `pointer` is unchanged by a zoom step. */
function expectPointerInvariant(
	before: ViewTransformState,
	after: ViewTransformState,
	pointer: ScreenSpacePoint
): void {
	expectImagePointClose(screenToImage(pointer, after), screenToImage(pointer, before));
}

describe('wheel zoom factor', () => {
	it('doubles and halves zoom per the documented deterministic rule', () => {
		expect(wheelZoomFactor(0)).toBe(1);
		expect(wheelZoomFactor(-WHEEL_ZOOM_STEP_DELTA)).toBe(2);
		expect(wheelZoomFactor(WHEEL_ZOOM_STEP_DELTA)).toBe(0.5);
		expect(wheelZoomFactor(-WHEEL_ZOOM_STEP_DELTA * 2)).toBe(4);
		expect(wheelZoomFactor(-100)).toBeCloseTo(Math.SQRT2, 12);
	});

	it('rejects non-finite deltaY', () => {
		expect(() => wheelZoomFactor(NaN)).toThrow(/finite/);
		expect(() => wheelZoomFactor(Infinity)).toThrow(/finite/);
		expect(() => wheelZoomFactor(-Infinity)).toThrow(/finite/);
	});
});

describe('zoom limits', () => {
	it('always include the current fit zoom', () => {
		const fitZooms = [0.001, 0.01, 0.1, 1, 140, 2666.6666666666665, 100000];
		for (const fit of fitZooms) {
			const limits = zoomLimitsForFit(fit);
			expect(limits.min).toBe(Math.min(ABSOLUTE_MIN_VIEW_ZOOM, fit / 16));
			expect(limits.max).toBe(Math.max(ABSOLUTE_MAX_VIEW_ZOOM, fit * 16));
			expect(limits.min).toBeLessThanOrEqual(fit);
			expect(fit).toBeLessThanOrEqual(limits.max);
		}
	});

	it('rejects invalid fit zooms', () => {
		expect(() => zoomLimitsForFit(0)).toThrow(/fitZoom/);
		expect(() => zoomLimitsForFit(-1)).toThrow(/fitZoom/);
		expect(() => zoomLimitsForFit(NaN)).toThrow(/fitZoom/);
		expect(() => zoomLimitsForFit(Infinity)).toThrow(/fitZoom/);
	});

	it('clamps into supplied limits and rejects invalid input', () => {
		expect(clampViewZoom(5, { min: 0.5, max: 4 })).toBe(4);
		expect(clampViewZoom(0.1, { min: 0.5, max: 4 })).toBe(0.5);
		expect(clampViewZoom(2, { min: 0.5, max: 4 })).toBe(2);
		expect(() => clampViewZoom(NaN, DEFAULT_VIEW_ZOOM_LIMITS)).toThrow(/zoom/);
		expect(() => clampViewZoom(2, { min: NaN, max: 4 })).toThrow(/limits/);
		expect(() => clampViewZoom(2, { min: 0.5, max: 0 })).toThrow(/limits/);
		expect(() => clampViewZoom(2, { min: 4, max: 0.5 })).toThrow(/limits/);
	});
});

describe('pointer-centered zoom', () => {
	it('zooms around the pointer at the identity transform', () => {
		const identity = { zoom: 1, panX: 0, panY: 0 };
		const pointer = { x: 10, y: 20 };
		const result = zoomAtPointer(identity, pointer, 2, DEFAULT_VIEW_ZOOM_LIMITS);
		expect(result).toEqual({ zoom: 2, panX: -10, panY: -20 });
		expectPointerInvariant(identity, result, pointer);
	});

	it('zooms around the pointer after a pan', () => {
		const before = { zoom: 1, panX: 100, panY: -50 };
		const pointer = { x: 200, y: 300 };
		const result = zoomAtPointer(before, pointer, 2, DEFAULT_VIEW_ZOOM_LIMITS);
		expect(result.zoom).toBe(2);
		expect(result.panX).toBeCloseTo(0, 12);
		expect(result.panY).toBeCloseTo(-400, 12);
		expectPointerInvariant(before, result, pointer);
	});

	it('zooms around the pointer after an existing zoom', () => {
		const before = { zoom: 2, panX: 5, panY: 7 };
		const pointer = { x: 60, y: 80 };
		const result = zoomAtPointer(before, pointer, 1.5, DEFAULT_VIEW_ZOOM_LIMITS);
		expect(result.zoom).toBeCloseTo(3, 12);
		expect(result.panX).toBeCloseTo(-22.5, 12);
		expect(result.panY).toBeCloseTo(-29.5, 12);
		expectPointerInvariant(before, result, pointer);
	});

	it('zooms in and out symmetrically', () => {
		const start = { zoom: 1, panX: 12, panY: -7 };
		const pointer = { x: 40, y: 90 };
		const zoomedIn = zoomAtPointer(start, pointer, 2, DEFAULT_VIEW_ZOOM_LIMITS);
		expect(zoomedIn.zoom).toBe(2);
		expectPointerInvariant(start, zoomedIn, pointer);
		const zoomedOut = zoomAtPointer(zoomedIn, pointer, 0.5, DEFAULT_VIEW_ZOOM_LIMITS);
		expect(zoomedOut.zoom).toBe(1);
		expect(zoomedOut.panX).toBeCloseTo(start.panX, 12);
		expect(zoomedOut.panY).toBeCloseTo(start.panY, 12);
	});

	it('clamps to the pane-specific minimum and maximum while keeping the pointer fixed', () => {
		const limits = { min: 0.5, max: 4 };
		const start = { zoom: 1, panX: 0, panY: 0 };
		const pointer = { x: 100, y: 100 };

		const maxed = zoomAtPointer(start, pointer, 1000, limits);
		expect(maxed.zoom).toBe(4);
		expectPointerInvariant(start, maxed, pointer);
		expect(screenToImage(pointer, maxed)).toEqual({ xPx: 100, yPx: 100 });

		const minned = zoomAtPointer(start, pointer, 0.001, limits);
		expect(minned.zoom).toBe(0.5);
		expectPointerInvariant(start, minned, pointer);
		expect(screenToImage(pointer, minned)).toEqual({ xPx: 100, yPx: 100 });
	});

	it('keeps the pointer anchored through a combined pan/zoom sequence', () => {
		let transform: ViewTransformState = { zoom: 1.4, panX: -92, panY: 17 };
		const firstPointer = { x: 200, y: 120 };
		transform = zoomAtPointer(transform, firstPointer, 0.75, DEFAULT_VIEW_ZOOM_LIMITS);
		expectPointerInvariant({ zoom: 1.4, panX: -92, panY: 17 }, transform, firstPointer);
		transform = panBy(transform, 30, -15);
		const secondPointer = { x: 150, y: 90 };
		const beforeSecond = { ...transform };
		transform = zoomAtPointer(transform, secondPointer, 1.25, DEFAULT_VIEW_ZOOM_LIMITS);
		expectPointerInvariant(beforeSecond, transform, secondPointer);
		transform = panBy(transform, -8.5, 3.25);
		transform = zoomAtPointer(transform, { x: 64, y: 48 }, 2, DEFAULT_VIEW_ZOOM_LIMITS);

		const probe: ImageSpacePoint = { xPx: 748.25, yPx: 720.5 };
		expectImagePointClose(screenToImage(imageToScreen(probe, transform), transform), probe);
	});

	it('rejects non-finite pointers, factors, and transforms', () => {
		const valid = { zoom: 1, panX: 0, panY: 0 };
		expect(() => zoomAtPointer(valid, { x: NaN, y: 0 }, 2)).toThrow(/pointer/);
		expect(() => zoomAtPointer(valid, { x: 0, y: Infinity }, 2)).toThrow(/pointer/);
		expect(() => zoomAtPointer(valid, { x: 0, y: 0 }, NaN)).toThrow(/zoomFactor/);
		expect(() => zoomAtPointer(valid, { x: 0, y: 0 }, 0)).toThrow(/zoomFactor/);
		expect(() => zoomAtPointer(valid, { x: 0, y: 0 }, -1)).toThrow(/zoomFactor/);
		expect(() => zoomAtPointer({ zoom: 0, panX: 0, panY: 0 }, { x: 0, y: 0 }, 2)).toThrow(
			/zoom/
		);
		expect(() =>
			zoomAtPointer({ zoom: 1, panX: NaN, panY: 0 }, { x: 0, y: 0 }, 2)
		).toThrow(/finite/);
	});
});

describe('pan deltas', () => {
	it('applies CSS-pixel pan deltas while retaining zoom', () => {
		const result = panBy({ zoom: 1.5, panX: 3, panY: -4 }, 10, -5);
		expect(result).toEqual({ zoom: 1.5, panX: 13, panY: -9 });
	});

	it('rejects non-finite deltas and transforms', () => {
		expect(() => panBy({ zoom: 1, panX: 0, panY: 0 }, NaN, 0)).toThrow(/finite/);
		expect(() => panBy({ zoom: 1, panX: 0, panY: 0 }, 0, Infinity)).toThrow(/finite/);
		expect(() => panBy({ zoom: -1, panX: 0, panY: 0 }, 1, 1)).toThrow(/zoom/);
	});
});

describe('default fit (Fit and Reset target)', () => {
	it('equals the P0-003 fit transform exactly for every pane size', () => {
		const cases = [
			[100, 200, 400, 300],
			[200, 100, 150, 400],
			[2, 3, 614, 418],
			[5, 4, 614, 418],
			[1179, 2556, 621, 133],
			[100000, 50000, 100, 100],
			[2, 3, 10000, 8000]
		] as const;
		for (const [iw, ih, pw, ph] of cases) {
			expect(defaultFitTransform(iw, ih, pw, ph)).toEqual(
				fitViewTransform(iw, ih, pw, ph)
			);
		}
	});

	it('fits an extreme large image completely without clamping to a minimum', () => {
		const fit = defaultFitTransform(100000, 50000, 100, 100);
		expect(fit.zoom).toBeCloseTo(0.001, 12);
		expect(fit.zoom).toBeLessThan(ABSOLUTE_MIN_VIEW_ZOOM);
		expect(fit).toEqual({ zoom: 0.001, panX: 0, panY: 25 });
	});

	it('fits an extreme tiny image completely without clamping to a maximum', () => {
		const fit = defaultFitTransform(2, 3, 10000, 8000);
		expect(fit.zoom).toBeCloseTo(8000 / 3, 12);
		expect(fit.zoom).toBeGreaterThan(ABSOLUTE_MAX_VIEW_ZOOM);
		expect(fit.panX).toBeCloseTo((10000 - 2 * fit.zoom) / 2, 12);
		expect(fit.panY).toBe(0);
	});

	it('shows the complete image: fit zoom equals the limiting pane ratio', () => {
		const portrait = defaultFitTransform(1179, 2556, 614, 418);
		expect(portrait.zoom).toBeCloseTo(418 / 2556, 12);
		const landscape = defaultFitTransform(1600, 1200, 614, 418);
		expect(landscape.zoom).toBeCloseTo(418 / 1200, 12);
	});

	it('rejects invalid image or pane dimensions', () => {
		expect(() => defaultFitTransform(0, 100, 100, 100)).toThrow(/positive/);
		expect(() => defaultFitTransform(100, 100, 0, 100)).toThrow(/positive/);
		expect(() => defaultFitTransform(100, 100, 100, NaN)).toThrow(/positive/);
	});
});

describe('resize behavior', () => {
	it('recomputes the default fit when resizing while at default fit', () => {
		const start = defaultFitTransform(100, 200, 400, 300);
		expect(start).toEqual({ zoom: 1.5, panX: 125, panY: 0 });
		const resized = resizeViewTransform(start, 100, 200, 400, 300, 200, 150);
		expect(resized).toEqual(defaultFitTransform(100, 200, 200, 150));
		expect(resized.zoom).toBe(0.75);
		expect(resized.panX).toBe(62.5);
		expect(resized.panY).toBe(0);
	});

	it('keeps zoom and preserves the image point under the pane center from a custom view', () => {
		const custom = { zoom: 3, panX: 10, panY: 20 };
		const resized = resizeViewTransform(custom, 100, 200, 400, 300, 500, 200);
		expect(resized.zoom).toBe(3);
		expect(resized.panX).toBeCloseTo(60, 12);
		expect(resized.panY).toBeCloseTo(-30, 12);

		const oldAnchor = screenToImage({ x: 200, y: 150 }, custom);
		const newUnderCenter = screenToImage({ x: 250, y: 100 }, resized);
		expectImagePointClose(newUnderCenter, oldAnchor);
	});

	it('is a no-op when the pane size does not change', () => {
		const custom = { zoom: 2.5, panX: -40, panY: 55 };
		const result = resizeViewTransform(custom, 100, 100, 400, 300, 400, 300);
		expect(result.zoom).toBe(custom.zoom);
		expect(result.panX).toBeCloseTo(custom.panX, 12);
		expect(result.panY).toBeCloseTo(custom.panY, 12);
	});

	it('rejects non-finite or zero dimensions', () => {
		const valid = { zoom: 1, panX: 0, panY: 0 };
		expect(() => resizeViewTransform(valid, 0, 100, 400, 300, 400, 300)).toThrow(/positive/);
		expect(() => resizeViewTransform(valid, 100, 100, 0, 300, 400, 300)).toThrow(/positive/);
		expect(() => resizeViewTransform(valid, 100, 100, 400, 300, NaN, 300)).toThrow(/positive/);
		expect(() => resizeViewTransform(valid, 100, 100, 400, 300, 400, Infinity)).toThrow(
			/positive/
		);
		expect(() => resizeViewTransform({ zoom: 1, panX: NaN, panY: 0 }, 100, 100, 400, 300, 400, 300)).toThrow(
			/finite/
		);
	});
});

describe('repeated operations stay within tolerance', () => {
	it('round-trips a probe through a long navigation sequence', () => {
		let transform: ViewTransformState = defaultFitTransform(1179, 2556, 614, 418);
		const pointers: ScreenSpacePoint[] = [
			{ x: 10, y: 10 },
			{ x: 300, y: 200 },
			{ x: 600, y: 400 },
			{ x: 100, y: 350 }
		];
		for (let i = 0; i < 20; i += 1) {
			transform = zoomAtPointer(
				transform,
				pointers[i % pointers.length],
				wheelZoomFactor(i % 2 === 0 ? -200 : 200),
				zoomLimitsForFit(transform.zoom)
			);
			transform = panBy(transform, i * 3.25 - 7.5, 10.75 - i * 1.5);
		}
		const probe: ImageSpacePoint = { xPx: 748.25, yPx: 720.5 };
		expectImagePointClose(screenToImage(imageToScreen(probe, transform), transform), probe);
	});

	it('returns exactly to the default fit after arbitrary navigation', () => {
		const image = { widthPx: 1179, heightPx: 2556 };
		const pane = { width: 614, height: 418 };
		const fit = defaultFitTransform(image.widthPx, image.heightPx, pane.width, pane.height);
		let transform = fit;
		transform = zoomAtPointer(transform, { x: 90, y: 120 }, 1.75, zoomLimitsForFit(fit.zoom));
		transform = panBy(transform, -33, 41);
		transform = zoomAtPointer(transform, { x: 500, y: 90 }, 0.6, zoomLimitsForFit(fit.zoom));
		expect(defaultFitTransform(image.widthPx, image.heightPx, pane.width, pane.height)).toEqual(
			fit
		);
	});
});

describe('device-pixel-ratio independence', () => {
	it('produces identical navigation results for CSS-pixel pointers under any device pixel ratio', () => {
		const start: ViewTransformState = { zoom: 1.37, panX: -92, panY: 17 };
		const cssPointer = { x: 200.5, y: 120.25 };
		const limits = zoomLimitsForFit(1.37);

		const results: ViewTransformState[] = [];
		for (const dpr of [1, 1.5, 2, 3]) {
			// Simulated high-DPI backing store: device pixels convert back to the
			// same CSS-pixel pointer before any navigation math runs.
			const backingStore = { x: cssPointer.x * dpr, y: cssPointer.y * dpr };
			const cssAgain = { x: backingStore.x / dpr, y: backingStore.y / dpr };
			results.push(zoomAtPointer(start, cssAgain, 1.5, limits));
		}
		for (const result of results) {
			expect(result).toEqual(results[0]);
		}
	});
});
