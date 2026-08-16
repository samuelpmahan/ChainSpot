import { describe, expect, it } from 'vitest';
import {
	BOUNDS_EPSILON,
	ROUND_TRIP_TOLERANCE,
	clampPointToImageBounds,
	fitViewTransform,
	identityViewTransform,
	imageToScreen,
	imageToScreenRotated,
	normalizeRotationDeg,
	normalizedConsistentWithPixels,
	pointInBounds,
	rotatePointAroundCenter,
	screenToImage,
	screenToImageRotated,
	toNormalizedCoordinates
} from '../../src/lib/coords';
import type { ImageSpacePoint, ViewTransformState } from '../../src/lib/coords';

function expectImagePointClose(actual: ImageSpacePoint, expected: ImageSpacePoint): void {
	expect(Math.abs(actual.xPx - expected.xPx)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE);
	expect(Math.abs(actual.yPx - expected.yPx)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE);
}

describe('view-transform conversions', () => {
	const identity: ViewTransformState = { zoom: 1, panX: 0, panY: 0 };

	it('maps image to screen and back at the identity transform', () => {
		const point = { xPx: 748.25, yPx: 720.5 };
		const screen = imageToScreen(point, identity);
		expect(screen).toEqual({ x: 748.25, y: 720.5 });
		expectImagePointClose(screenToImage(screen, identity), point);
	});

	it('applies pan-only translation in both directions', () => {
		const transform: ViewTransformState = { zoom: 1, panX: -92, panY: 17 };
		const point = { xPx: 100, yPx: 200 };
		const screen = imageToScreen(point, transform);
		expect(screen).toEqual({ x: 8, y: 217 });
		expectImagePointClose(screenToImage(screen, transform), point);
	});

	it('applies zoom-only scaling in both directions', () => {
		const transform: ViewTransformState = { zoom: 2, panX: 0, panY: 0 };
		const point = { xPx: 100, yPx: 200 };
		const screen = imageToScreen(point, transform);
		expect(screen).toEqual({ x: 200, y: 400 });
		expectImagePointClose(screenToImage(screen, transform), point);
	});

	it('applies combined pan and zoom in both directions', () => {
		const transform: ViewTransformState = { zoom: 1.4, panX: -92, panY: 17 };
		const point = { xPx: 748.25, yPx: 720.5 };
		const screen = imageToScreen(point, transform);
		expect(screen).toEqual({ x: 748.25 * 1.4 - 92, y: 720.5 * 1.4 + 17 });
		expectImagePointClose(screenToImage(screen, transform), point);
	});

	it('handles negative translations and non-integer scales', () => {
		const transform: ViewTransformState = { zoom: 0.37, panX: -1234.5, panY: 567.25 };
		const point = { xPx: 33.75, yPx: 12.5 };
		const screen = imageToScreen(point, transform);
		expect(screen.x).toBeCloseTo(33.75 * 0.37 - 1234.5, 12);
		expect(screen.y).toBeCloseTo(12.5 * 0.37 + 567.25, 12);
		expectImagePointClose(screenToImage(screen, transform), point);
	});

	it('rejects degenerate transforms instead of silently dividing by zero', () => {
		expect(() => imageToScreen({ xPx: 1, yPx: 1 }, { zoom: 0, panX: 0, panY: 0 })).toThrow(
			/zoom/
		);
		expect(() =>
			screenToImage({ x: 1, y: 1 }, { zoom: 0, panX: 0, panY: 0 })
		).toThrow(/zoom/);
		expect(() =>
			screenToImage({ x: 1, y: 1 }, { zoom: 1, panX: NaN, panY: 0 })
		).toThrow(/finite/);
	});

	it('round-trips representative points across representative transforms', () => {
		const transforms: ViewTransformState[] = [
			identity,
			{ zoom: 1, panX: -92, panY: 17 },
			{ zoom: 2, panX: 0, panY: 0 },
			{ zoom: 1.4, panX: -92, panY: 17 },
			{ zoom: 0.37, panX: -1234.5, panY: 567.25 },
			{ zoom: 0.05, panX: 300, panY: -40 },
			{ zoom: 5, panX: -10.25, panY: 4.75 }
		];
		const points: ImageSpacePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 748.25, yPx: 720.5 },
			{ xPx: 1178.999, yPx: 2555.999 },
			{ xPx: 12.5, yPx: 33.75 },
			{ xPx: 0.1, yPx: 123.456789 }
		];
		for (const transform of transforms) {
			for (const point of points) {
				expectImagePointClose(screenToImage(imageToScreen(point, transform), transform), point);
			}
		}
	});

	it('returns the domain-persisted view-state shape', () => {
		const transform: ViewTransformState = fitViewTransform(100, 200, 400, 300);
		expect(transform).toEqual({ zoom: expect.any(Number), panX: expect.any(Number), panY: expect.any(Number) });
	});
});

describe('normalized coordinates', () => {
	it('derives normalized values from original pixels and intrinsic dimensions', () => {
		const point = { xPx: 748.25, yPx: 720.5 };
		expect(toNormalizedCoordinates(point, 1179, 2556)).toEqual({
			xNorm: 748.25 / 1179,
			yNorm: 720.5 / 2556
		});
	});

	it('maps image-space zero to zero and exact boundary division to one', () => {
		expect(toNormalizedCoordinates({ xPx: 0, yPx: 0 }, 1179, 2556)).toEqual({
			xNorm: 0,
			yNorm: 0
		});
		const boundary = toNormalizedCoordinates({ xPx: 1179, yPx: 2556 }, 1179, 2556);
		expect(boundary.xNorm).toBe(1);
		expect(boundary.yNorm).toBe(1);

		const inBounds = toNormalizedCoordinates(
			{ xPx: 1179 - BOUNDS_EPSILON, yPx: 2556 - BOUNDS_EPSILON },
			1179,
			2556
		);
		expect(inBounds.xNorm).toBeLessThan(1);
		expect(inBounds.yNorm).toBeLessThan(1);
	});

	it('rejects zero, negative, and non-finite dimensions', () => {
		expect(() => toNormalizedCoordinates({ xPx: 1, yPx: 1 }, 0, 100)).toThrow(/positive/);
		expect(() => toNormalizedCoordinates({ xPx: 1, yPx: 1 }, 100, -1)).toThrow(/positive/);
		expect(() => toNormalizedCoordinates({ xPx: 1, yPx: 1 }, NaN, 100)).toThrow(/positive/);
		expect(() => toNormalizedCoordinates({ xPx: 1, yPx: 1 }, 100, Infinity)).toThrow(/positive/);
	});

	it('verifies stored normalized values against pixels and detects discrepancies', () => {
		const consistent = {
			xPx: 748.25,
			yPx: 720.5,
			xNorm: 748.25 / 1179,
			yNorm: 720.5 / 2556
		};
		expect(normalizedConsistentWithPixels(consistent, 1179, 2556)).toBe(true);

		const inconsistent = { ...consistent, xNorm: 0.999 };
		expect(normalizedConsistentWithPixels(inconsistent, 1179, 2556)).toBe(false);
	});

	it('honors a caller-supplied tolerance', () => {
		const point = {
			xPx: 748.25,
			yPx: 720.5,
			xNorm: 0.6,
			yNorm: 720.5 / 2556
		};
		expect(normalizedConsistentWithPixels(point, 1179, 2556, 0.05)).toBe(true);
	});

	it('rejects non-finite or negative tolerances', () => {
		const point = {
			xPx: 748.25,
			yPx: 720.5,
			xNorm: 0.5,
			yNorm: 0.3
		};
		expect(() => normalizedConsistentWithPixels(point, 1179, 2556, Infinity)).toThrow(
			/tolerance/
		);
		expect(() => normalizedConsistentWithPixels(point, 1179, 2556, NaN)).toThrow(/tolerance/);
		expect(() => normalizedConsistentWithPixels(point, 1179, 2556, -1)).toThrow(/tolerance/);
	});
});

describe('bounds policy', () => {
	const width = 100;
	const height = 50;

	it('accepts points strictly inside the half-open bounds', () => {
		expect(pointInBounds({ xPx: 0, yPx: 0 }, width, height)).toBe(true);
		expect(pointInBounds({ xPx: 99.999, yPx: 49.999 }, width, height)).toBe(true);
		expect(pointInBounds({ xPx: width - BOUNDS_EPSILON, yPx: height - BOUNDS_EPSILON }, width, height)).toBe(true);
	});

	it('rejects points at or beyond every edge', () => {
		expect(pointInBounds({ xPx: width, yPx: 10 }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: 10, yPx: height }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: -1, yPx: 10 }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: 10, yPx: -1 }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: width + 1, yPx: height + 1 }, width, height)).toBe(false);
	});

	it('clamps out-of-bounds values back inside the bounds at every edge', () => {
		expect(clampPointToImageBounds({ xPx: -5, yPx: -5 }, width, height)).toEqual({ xPx: 0, yPx: 0 });
		expect(clampPointToImageBounds({ xPx: 500, yPx: 500 }, width, height)).toEqual({
			xPx: width - BOUNDS_EPSILON,
			yPx: height - BOUNDS_EPSILON
		});
		expect(clampPointToImageBounds({ xPx: 1000, yPx: 0 }, width, height)).toEqual({
			xPx: width - BOUNDS_EPSILON,
			yPx: 0
		});
		expect(clampPointToImageBounds({ xPx: 0, yPx: -1000 }, width, height)).toEqual({
			xPx: 0,
			yPx: 0
		});
	});

	it('keeps interior points unchanged and clamped values in bounds', () => {
		const interior = { xPx: 12.5, yPx: 33.75 };
		expect(clampPointToImageBounds(interior, width, height)).toEqual(interior);
		const clamped = clampPointToImageBounds({ xPx: 500, yPx: 500 }, width, height);
		expect(pointInBounds(clamped, width, height)).toBe(true);
	});

	it('rejects invalid dimensions in bounds helpers', () => {
		expect(() => pointInBounds({ xPx: 1, yPx: 1 }, 0, 10)).toThrow(/positive/);
		expect(() => clampPointToImageBounds({ xPx: 1, yPx: 1 }, 10, 0)).toThrow(/positive/);
	});

	it('rejects non-finite coordinates in clamping and reports them out of bounds', () => {
		expect(() =>
			clampPointToImageBounds({ xPx: NaN, yPx: 10 }, width, height)
		).toThrow(/finite/);
		expect(() =>
			clampPointToImageBounds({ xPx: 10, yPx: Infinity }, width, height)
		).toThrow(/finite/);
		expect(() =>
			clampPointToImageBounds({ xPx: -Infinity, yPx: 10 }, width, height)
		).toThrow(/finite/);

		expect(pointInBounds({ xPx: NaN, yPx: 10 }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: 10, yPx: Infinity }, width, height)).toBe(false);
		expect(pointInBounds({ xPx: -Infinity, yPx: 10 }, width, height)).toBe(false);
	});
});

describe('fit transforms', () => {
	it('fits a portrait image into a landscape pane, centered, aspect preserved', () => {
		const transform = fitViewTransform(100, 200, 400, 300);
		expect(transform.zoom).toBe(1.5);
		expect(transform.panX).toBe((400 - 100 * 1.5) / 2);
		expect(transform.panY).toBe(0);
		expect(transform.zoom).toBeCloseTo(300 / 200, 12);
	});

	it('fits a landscape image into a portrait pane, centered, aspect preserved', () => {
		const transform = fitViewTransform(200, 100, 150, 400);
		expect(transform.zoom).toBe(0.75);
		expect(transform.panX).toBe(0);
		expect(transform.panY).toBe((400 - 100 * 0.75) / 2);
	});

	it('fits a square image into a square pane exactly', () => {
		const transform = fitViewTransform(100, 100, 100, 100);
		expect(transform).toEqual({ zoom: 1, panX: 0, panY: 0 });
	});

	it('scales a large image down to fit a narrow pane', () => {
		const transform = fitViewTransform(1600, 1200, 320, 240);
		expect(transform.zoom).toBe(0.2);
		expect(transform.panX).toBe(0);
		expect(transform.panY).toBe(0);
	});

	it('is deterministic and preserves aspect ratio for any pane size', () => {
		const first = fitViewTransform(1179, 2556, 621, 133);
		const second = fitViewTransform(1179, 2556, 621, 133);
		expect(second).toEqual(first);
		expect(first.panX).toBeCloseTo((621 - 1179 * first.zoom) / 2, 12);
		expect(first.panY).toBeCloseTo((133 - 2556 * first.zoom) / 2, 12);
	});

	it('rejects zero or non-finite pane dimensions', () => {
		expect(() => fitViewTransform(100, 100, 0, 100)).toThrow(/positive/);
		expect(() => fitViewTransform(100, 100, 100, NaN)).toThrow(/positive/);
		expect(() => fitViewTransform(0, 100, 100, 100)).toThrow(/positive/);
	});
});

describe('device-pixel-ratio independence', () => {
	it('receives CSS pixels and produces identical image points for any device pixel ratio', () => {
		const transform: ViewTransformState = { zoom: 1.37, panX: -92, panY: 17 };
		const point = { xPx: 748.25, yPx: 720.5 };
		const cssScreen = imageToScreen(point, transform);

		// Simulated high-DPI backing store: convert the CSS-space point to device
		// pixels and back before inversion, exercising each DPR value. Project math
		// must receive CSS pixels and yield the same image point every time.
		const devicePixelRatios = [1, 1.5, 2, 3];
		for (const dpr of devicePixelRatios) {
			const backingStore = { x: cssScreen.x * dpr, y: cssScreen.y * dpr };
			const cssAgain = { x: backingStore.x / dpr, y: backingStore.y / dpr };
			expectImagePointClose(screenToImage(cssAgain, transform), point);
		}
	});

	it('conversion results do not depend on identityViewTransform defaults', () => {
		const identity = identityViewTransform();
		expect(identity).toEqual({ zoom: 1, panX: 0, panY: 0 });
		expect(screenToImage({ x: 5, y: 7 }, identity)).toEqual({ xPx: 5, yPx: 7 });
	});
});

describe('normalizeRotationDeg', () => {
	it('leaves values already inside (-180, 180] unchanged', () => {
		expect(normalizeRotationDeg(0)).toBe(0);
		expect(normalizeRotationDeg(45.5)).toBe(45.5);
		expect(normalizeRotationDeg(-179.9)).toBeCloseTo(-179.9, 9);
		expect(normalizeRotationDeg(180)).toBe(180);
	});

	it('wraps values outside the range to an equivalent angle', () => {
		expect(normalizeRotationDeg(360)).toBe(0);
		expect(normalizeRotationDeg(400)).toBeCloseTo(40, 9);
		expect(normalizeRotationDeg(-400)).toBeCloseTo(-40, 9);
		expect(normalizeRotationDeg(181)).toBeCloseTo(-179, 9);
		expect(normalizeRotationDeg(-181)).toBeCloseTo(179, 9);
	});

	it('rejects non-finite input', () => {
		expect(() => normalizeRotationDeg(NaN)).toThrow(/finite/);
		expect(() => normalizeRotationDeg(Infinity)).toThrow(/finite/);
	});
});

describe('rotatePointAroundCenter', () => {
	const center = { xPx: 50, yPx: 50 };

	it('is the identity at 0 degrees', () => {
		const point = { xPx: 70, yPx: 30 };
		expect(rotatePointAroundCenter(point, center, 0)).toEqual(point);
	});

	it('leaves the center point fixed at any angle', () => {
		expect(rotatePointAroundCenter(center, center, 37)).toEqual(center);
	});

	it('rotates a point 90 degrees clockwise in this y-down space', () => {
		// "right of center" rotates to "below center" under a clockwise turn.
		const right = { xPx: 100, yPx: 50 };
		const rotated = rotatePointAroundCenter(right, center, 90);
		expect(rotated.xPx).toBeCloseTo(50, 9);
		expect(rotated.yPx).toBeCloseTo(100, 9);
	});

	it('composes 180 degrees as the point reflected through the center', () => {
		const point = { xPx: 80, yPx: 20 };
		const rotated = rotatePointAroundCenter(point, center, 180);
		expect(rotated.xPx).toBeCloseTo(20, 9);
		expect(rotated.yPx).toBeCloseTo(80, 9);
	});
});

describe('imageToScreenRotated / screenToImageRotated', () => {
	const center = { xPx: 100, yPx: 80 };
	const transform: ViewTransformState = { zoom: 1.6, panX: -30, panY: 12 };

	it('matches the unrotated conversion at rotationDeg 0', () => {
		const point = { xPx: 42, yPx: 17 };
		expect(imageToScreenRotated(point, transform, 0, center)).toEqual(imageToScreen(point, transform));
		const screen = imageToScreen(point, transform);
		expect(screenToImageRotated(screen, transform, 0, center)).toEqual(screenToImage(screen, transform));
	});

	it('keeps the rotation pivot fixed on screen at the pan/zoom-mapped center', () => {
		const screen = imageToScreenRotated(center, transform, 37, center);
		expect(screen.x).toBeCloseTo(imageToScreen(center, transform).x, 9);
		expect(screen.y).toBeCloseTo(imageToScreen(center, transform).y, 9);
	});

	it('round-trips representative points at representative rotations', () => {
		const points: ImageSpacePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 160 },
			{ xPx: 33.5, yPx: 91.25 },
			center
		];
		const rotations = [0, 15, 90, 179.5, -45, -170];
		for (const rotationDeg of rotations) {
			for (const point of points) {
				const screen = imageToScreenRotated(point, transform, rotationDeg, center);
				const back = screenToImageRotated(screen, transform, rotationDeg, center);
				expect(back.xPx).toBeCloseTo(point.xPx, 6);
				expect(back.yPx).toBeCloseTo(point.yPx, 6);
			}
		}
	});
});
