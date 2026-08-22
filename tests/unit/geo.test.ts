import { describe, expect, test } from 'vitest';
import { fitTransform, toLatLng, distanceFt, type CorrespondencePair, type Point, type LatLng, type WorldTransform } from '$lib/geo';

const METERS_PER_DEG_LAT = 111_320;
const FT_PER_METER = 3.28084;

// Test helper: convert lat/lng to local flat meters relative to an origin (South axis).
function toLocalMetersHelper(ll: LatLng, origin: LatLng): { x: number; y: number } {
	const latRad = origin.lat * (Math.PI / 180);
	const cosLat = Math.cos(latRad);
	const eastM = (ll.lng - origin.lng) * METERS_PER_DEG_LAT * cosLat;
	const southM = -(ll.lat - origin.lat) * METERS_PER_DEG_LAT;
	return { x: eastM, y: southM };
}

// Test helper: convert local flat meters to lat/lng relative to an origin.
function fromLocalMetersHelper(m: { x: number; y: number }, origin: LatLng): LatLng {
	const latRad = origin.lat * (Math.PI / 180);
	const cosLat = Math.cos(latRad);
	const lat = origin.lat - m.y / METERS_PER_DEG_LAT;
	const lng = origin.lng + m.x / (METERS_PER_DEG_LAT * cosLat);
	return { lat, lng };
}

// Test helper: forward transform a point in pixel space using a known transform.
function forwardTransformHelper(
	blankPx: Point,
	knownScale: number,
	knownRotRad: number,
	knownOrigin: LatLng
): LatLng {
	// Rotate and scale in pixel space.
	const cosRot = Math.cos(knownRotRad);
	const sinRot = Math.sin(knownRotRad);
	const eastM = knownScale * (blankPx.xPx * cosRot - blankPx.yPx * sinRot);
	const southM = knownScale * (blankPx.xPx * sinRot + blankPx.yPx * cosRot);

	// Convert meters back to lat/lng.
	return fromLocalMetersHelper({ x: eastM, y: southM }, knownOrigin);
}

describe('fitTransform', () => {
	test('returns null for empty pairs array', () => {
		expect(fitTransform([])).toBeNull();
	});

	test('returns null for single pair', () => {
		const pair: CorrespondencePair = {
			blankPx: { xPx: 10, yPx: 20 },
			latLng: { lat: 45, lng: -93 },
		};
		expect(fitTransform([pair])).toBeNull();
	});

	test('returns null for degenerate case: identical blankPx points', () => {
		const pairs: CorrespondencePair[] = [
			{
				blankPx: { xPx: 50, yPx: 50 },
				latLng: { lat: 45.0, lng: -93.0 },
			},
			{
				blankPx: { xPx: 50, yPx: 50 },
				latLng: { lat: 45.01, lng: -93.01 },
			},
		];
		expect(fitTransform(pairs)).toBeNull();
	});

	test('recovers a known transform from 2 synthetic pairs', () => {
		// Known transform parameters.
		const knownScale = 0.5; // meters per pixel
		const knownRotRad = Math.PI / 6; // 30 degrees
		const knownOrigin: LatLng = { lat: 45, lng: -93 };

		// Create synthetic correspondence pairs using the known transform.
		const blankPx1: Point = { xPx: 100, yPx: 0 };
		const blankPx2: Point = { xPx: 0, yPx: 100 };

		const latLng1 = forwardTransformHelper(blankPx1, knownScale, knownRotRad, knownOrigin);
		const latLng2 = forwardTransformHelper(blankPx2, knownScale, knownRotRad, knownOrigin);

		const pairs: CorrespondencePair[] = [
			{ blankPx: blankPx1, latLng: latLng1 },
			{ blankPx: blankPx2, latLng: latLng2 },
		];

		const fitted = fitTransform(pairs);
		expect(fitted).not.toBeNull();
		if (!fitted) return;

		// Check recovered parameters.
		expect(fitted.scale).toBeCloseTo(knownScale, 4);
		expect(fitted.rotationRad).toBeCloseTo(knownRotRad, 4);
		expect(fitted.originLatLng.lat).toBeCloseTo(knownOrigin.lat, 3);
		expect(fitted.originLatLng.lng).toBeCloseTo(knownOrigin.lng, 3);
	});

	test('recovers a known transform from 3 synthetic pairs', () => {
		const knownScale = 0.5;
		const knownRotRad = Math.PI / 6;
		const knownOrigin: LatLng = { lat: 45, lng: -93 };

		const blankPxPoints: Point[] = [
			{ xPx: 100, yPx: 0 },
			{ xPx: 0, yPx: 100 },
			{ xPx: 50, yPx: 50 },
		];

		const pairs: CorrespondencePair[] = blankPxPoints.map((blankPx) => ({
			blankPx,
			latLng: forwardTransformHelper(blankPx, knownScale, knownRotRad, knownOrigin),
		}));

		const fitted = fitTransform(pairs);
		expect(fitted).not.toBeNull();
		if (!fitted) return;

		expect(fitted.scale).toBeCloseTo(knownScale, 4);
		expect(fitted.rotationRad).toBeCloseTo(knownRotRad, 4);
		expect(fitted.originLatLng.lat).toBeCloseTo(knownOrigin.lat, 3);
		expect(fitted.originLatLng.lng).toBeCloseTo(knownOrigin.lng, 3);
	});
});

describe('toLatLng', () => {
	test('round-trip: toLatLng recovers original latLng for each pair', () => {
		const knownScale = 0.5;
		const knownRotRad = Math.PI / 6;
		const knownOrigin: LatLng = { lat: 45, lng: -93 };

		const blankPxPoints: Point[] = [
			{ xPx: 100, yPx: 0 },
			{ xPx: 0, yPx: 100 },
			{ xPx: 50, yPx: 50 },
		];

		const pairs: CorrespondencePair[] = blankPxPoints.map((blankPx) => ({
			blankPx,
			latLng: forwardTransformHelper(blankPx, knownScale, knownRotRad, knownOrigin),
		}));

		const fitted = fitTransform(pairs);
		expect(fitted).not.toBeNull();
		if (!fitted) return;

		// For each pair, verify that toLatLng returns the original latLng.
		for (const pair of pairs) {
			const recovered = toLatLng(fitted, pair.blankPx);
			expect(recovered.lat).toBeCloseTo(pair.latLng.lat, 6);
			expect(recovered.lng).toBeCloseTo(pair.latLng.lng, 6);
		}
	});
});

describe('distanceFt', () => {
	test('computes distance exactly for a scale of 2 m/px', () => {
		// Create pairs such that the fitted scale is exactly 2 m/px with rotation 0.
		// Use two pairs aligned on the x-axis in pixel space, 100px apart, mapped to 200m apart on ground.
		const origin: LatLng = { lat: 45, lng: -93 };
		const scale = 2; // meters per pixel
		const rotationRad = 0;

		// Pixel space points at (0, 0) and (100, 0) should map to ground 200m apart.
		const blankPx1: Point = { xPx: 0, yPx: 0 };
		const blankPx2: Point = { xPx: 100, yPx: 0 };

		// Create latLng by applying forward transform.
		const latLng1 = forwardTransformHelper(blankPx1, scale, rotationRad, origin);
		const latLng2 = forwardTransformHelper(blankPx2, scale, rotationRad, origin);

		const pairs: CorrespondencePair[] = [
			{ blankPx: blankPx1, latLng: latLng1 },
			{ blankPx: blankPx2, latLng: latLng2 },
		];

		const fitted = fitTransform(pairs);
		expect(fitted).not.toBeNull();
		if (!fitted) return;

		// Now test distanceFt: (30, 40) in pixels, distance = hypot(30, 40) = 50 pixels.
		// With scale=2 m/px, that's 100m = 328.084 ft.
		const p1: Point = { xPx: 0, yPx: 0 };
		const p2: Point = { xPx: 30, yPx: 40 };

		const expectedFt = 2 * 50 * FT_PER_METER; // 2 m/px * 50 px * 3.28084
		const actualFt = distanceFt(fitted, p1, p2);

		expect(actualFt).toBeCloseTo(expectedFt, 4);
	});

	test('distanceFt is symmetric', () => {
		const knownScale = 0.5;
		const knownRotRad = Math.PI / 6;
		const knownOrigin: LatLng = { lat: 45, lng: -93 };

		const blankPxPoints: Point[] = [
			{ xPx: 100, yPx: 0 },
			{ xPx: 0, yPx: 100 },
		];

		const pairs: CorrespondencePair[] = blankPxPoints.map((blankPx) => ({
			blankPx,
			latLng: forwardTransformHelper(blankPx, knownScale, knownRotRad, knownOrigin),
		}));

		const fitted = fitTransform(pairs);
		expect(fitted).not.toBeNull();
		if (!fitted) return;

		const p1: Point = { xPx: 50, yPx: 30 };
		const p2: Point = { xPx: 80, yPx: 60 };

		const dist12 = distanceFt(fitted, p1, p2);
		const dist21 = distanceFt(fitted, p2, p1);

		expect(dist12).toBeCloseTo(dist21, 10);
	});
});
