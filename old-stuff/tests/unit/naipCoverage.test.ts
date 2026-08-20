import { describe, expect, it } from 'vitest';
import {
	DEFAULT_VIEWPORT_RADIUS_METERS,
	MAX_VIEWPORT_RADIUS_METERS,
	MIN_VIEWPORT_RADIUS_METERS,
	coverageGap,
	expandedFetchGeometry,
	fetchGeometryFromViewport,
	naipGeoToPixel,
	naipPixelToGeo,
	remapNaipPixel
} from '../../src/lib/naipCoverage';
import type { NaipFetchGeometry } from '../../src/lib/naipCoverage';
import { NAIP_EXPORT_SIZE_PX, bboxFromCenter } from '../../src/lib/naip';

// Dash's Track, the MVP development course — same coordinate the page defaults to.
const CENTER = { lat: 33.12551979622626, lon: -96.86103869229555 };
const GEOMETRY: NaipFetchGeometry = { center: CENTER, radiusMeters: 300 };

describe('naipPixelToGeo / naipGeoToPixel', () => {
	it('maps the raster center pixel to the fetch center', () => {
		const half = NAIP_EXPORT_SIZE_PX / 2;
		const geo = naipPixelToGeo(GEOMETRY, { xPx: half, yPx: half });
		expect(geo.lat).toBeCloseTo(CENTER.lat, 10);
		expect(geo.lon).toBeCloseTo(CENTER.lon, 10);
	});

	it('maps pixel (0, 0) to the bbox north-west corner', () => {
		const bbox = bboxFromCenter(CENTER, GEOMETRY.radiusMeters);
		const geo = naipPixelToGeo(GEOMETRY, { xPx: 0, yPx: 0 });
		expect(geo.lat).toBeCloseTo(bbox.maxLat, 12);
		expect(geo.lon).toBeCloseTo(bbox.minLon, 12);
	});

	it('round-trips pixel -> geo -> pixel exactly (within float noise)', () => {
		const samples = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 2048, yPx: 2048 },
			{ xPx: 137.25, yPx: 1900.5 },
			{ xPx: -50, yPx: 2100 } // outside the raster: must still map linearly, never throw
		];
		for (const sample of samples) {
			const back = naipGeoToPixel(GEOMETRY, naipPixelToGeo(GEOMETRY, sample));
			expect(back.xPx).toBeCloseTo(sample.xPx, 6);
			expect(back.yPx).toBeCloseTo(sample.yPx, 6);
		}
	});
});

describe('remapNaipPixel', () => {
	it('is identity when old and new geometry are the same', () => {
		const point = { xPx: 512.5, yPx: 1024.25 };
		const mapped = remapNaipPixel(GEOMETRY, GEOMETRY, point);
		expect(mapped.xPx).toBeCloseTo(point.xPx, 6);
		expect(mapped.yPx).toBeCloseTo(point.yPx, 6);
	});

	it('halves pixel deltas from center when the radius doubles around the same center', () => {
		const bigger: NaipFetchGeometry = { center: CENTER, radiusMeters: 600 };
		const half = NAIP_EXPORT_SIZE_PX / 2;
		const point = { xPx: half + 400, yPx: half - 300 };
		const mapped = remapNaipPixel(GEOMETRY, bigger, point);
		expect(mapped.xPx).toBeCloseTo(half + 200, 6);
		expect(mapped.yPx).toBeCloseTo(half - 150, 6);
	});

	it('a fixed landmark stays at the same WGS84 coordinate across the remap', () => {
		const newGeometry: NaipFetchGeometry = {
			center: { lat: CENTER.lat + 0.001, lon: CENTER.lon - 0.002 },
			radiusMeters: 450
		};
		const oldPx = { xPx: 300, yPx: 1700 };
		const landmark = naipPixelToGeo(GEOMETRY, oldPx);
		const newPx = remapNaipPixel(GEOMETRY, newGeometry, oldPx);
		const landmarkAgain = naipPixelToGeo(newGeometry, newPx);
		expect(landmarkAgain.lat).toBeCloseTo(landmark.lat, 10);
		expect(landmarkAgain.lon).toBeCloseTo(landmark.lon, 10);
	});
});

describe('coverageGap', () => {
	it('reports no gap when every point is inside the raster', () => {
		const gap = coverageGap([{ xPx: 0, yPx: 0 }, { xPx: 2048, yPx: 2048 }], 2048, 2048);
		expect(gap.outside).toBe(false);
		expect(gap.outsideCount).toBe(0);
		expect(gap.bounds).toEqual({ minX: 0, minY: 0, maxX: 2048, maxY: 2048 });
	});

	it('counts and bounds points that exit the raster', () => {
		const gap = coverageGap(
			[
				{ xPx: 100, yPx: 100 },
				{ xPx: 2500, yPx: 90 },
				{ xPx: -60, yPx: 1000 }
			],
			2048,
			2048
		);
		expect(gap.outside).toBe(true);
		expect(gap.outsideCount).toBe(2);
		expect(gap.bounds).toEqual({ minX: -60, minY: 90, maxX: 2500, maxY: 1000 });
	});

	it('handles an empty point list', () => {
		const gap = coverageGap([], 2048, 2048);
		expect(gap.outside).toBe(false);
		expect(gap.bounds).toBeNull();
	});
});

describe('expandedFetchGeometry', () => {
	it('contains every old-raster pixel and every course point after the expansion', () => {
		// Course spills 700px east and 300px north of the old raster.
		const courseBounds = { minX: 400, minY: -300, maxX: 2748, maxY: 1800 };
		const expanded = expandedFetchGeometry(GEOMETRY, courseBounds);

		const corners = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 2048, yPx: 0 },
			{ xPx: 0, yPx: 2048 },
			{ xPx: 2048, yPx: 2048 },
			{ xPx: courseBounds.maxX, yPx: courseBounds.minY },
			{ xPx: courseBounds.minX, yPx: courseBounds.maxY }
		];
		for (const corner of corners) {
			const remapped = remapNaipPixel(GEOMETRY, expanded, corner);
			expect(remapped.xPx).toBeGreaterThanOrEqual(0);
			expect(remapped.yPx).toBeGreaterThanOrEqual(0);
			expect(remapped.xPx).toBeLessThanOrEqual(NAIP_EXPORT_SIZE_PX);
			expect(remapped.yPx).toBeLessThanOrEqual(NAIP_EXPORT_SIZE_PX);
		}
		expect(expanded.radiusMeters).toBeGreaterThan(GEOMETRY.radiusMeters);
	});

	it('is a no-growth-beyond-margin operation when the course already fits', () => {
		const expanded = expandedFetchGeometry(
			GEOMETRY,
			{ minX: 100, minY: 100, maxX: 1900, maxY: 1900 },
			{ marginFraction: 0 }
		);
		expect(expanded.radiusMeters).toBeCloseTo(GEOMETRY.radiusMeters, 6);
		expect(expanded.center.lat).toBeCloseTo(CENTER.lat, 10);
		expect(expanded.center.lon).toBeCloseTo(CENTER.lon, 10);
	});
});

describe('fetchGeometryFromViewport', () => {
	it('derives center and clamped radius from a real provider box', () => {
		// ~900m x ~600m park viewport around the course.
		const viewport = bboxFromCenter(CENTER, 450);
		const geometry = fetchGeometryFromViewport({ lat: 0, lon: 0 }, viewport);
		expect(geometry.fromViewport).toBe(true);
		// Center comes from the box, not the (deliberately bogus) result point.
		expect(geometry.center.lat).toBeCloseTo(CENTER.lat, 10);
		expect(geometry.center.lon).toBeCloseTo(CENTER.lon, 10);
		// Half-extent 450m x 1.15 margin.
		expect(geometry.radiusMeters).toBeCloseTo(450 * 1.15, 3);
	});

	it('falls back to the default radius for a missing box', () => {
		const geometry = fetchGeometryFromViewport(CENTER, undefined);
		expect(geometry.fromViewport).toBe(false);
		expect(geometry.center).toEqual(CENTER);
		expect(geometry.radiusMeters).toBe(DEFAULT_VIEWPORT_RADIUS_METERS);
	});

	it('treats a point-default box (< 120m across) as no box', () => {
		const geometry = fetchGeometryFromViewport(CENTER, bboxFromCenter(CENTER, 25));
		expect(geometry.fromViewport).toBe(false);
		expect(geometry.radiusMeters).toBe(DEFAULT_VIEWPORT_RADIUS_METERS);
	});

	it('clamps huge boxes to the maximum and small-but-real boxes to the minimum radius', () => {
		const huge = fetchGeometryFromViewport(CENTER, bboxFromCenter(CENTER, 5000));
		expect(huge.fromViewport).toBe(true);
		expect(huge.radiusMeters).toBe(MAX_VIEWPORT_RADIUS_METERS);

		// 70m half-extent x 1.15 = 80.5m, below the 150m floor.
		const small = fetchGeometryFromViewport(CENTER, bboxFromCenter(CENTER, 70));
		expect(small.fromViewport).toBe(true);
		expect(small.radiusMeters).toBe(MIN_VIEWPORT_RADIUS_METERS);
	});
});
