import { describe, expect, test } from 'vitest';
import { geoBoxCenterAndSize, pixelRectToGeoBox, planTileGrid, MAX_GRID_COLS, MAX_GRID_ROWS } from '../../src/lib/naipGrid';

describe('pixelRectToGeoBox', () => {
	test('maps a pixel rectangle linearly onto the reference bbox (y inverted: image-down is lat-down)', () => {
		const referenceBbox = { minLon: -10, maxLon: 10, minLat: -10, maxLat: 10 };
		const box = pixelRectToGeoBox(referenceBbox, 1000, { x: 250, y: 250, width: 500, height: 500 });
		expect(box.minLon).toBeCloseTo(-5, 9);
		expect(box.maxLon).toBeCloseTo(5, 9);
		// A rect starting at y=250 (near the top) should land near maxLat, not minLat.
		expect(box.maxLat).toBeCloseTo(5, 9);
		expect(box.minLat).toBeCloseTo(-5, 9);
	});

	test('the full-image rectangle round-trips to the reference bbox exactly', () => {
		const referenceBbox = { minLon: -93.3, maxLon: -93.2, minLat: 44.9, maxLat: 45.0 };
		const box = pixelRectToGeoBox(referenceBbox, 2048, { x: 0, y: 0, width: 2048, height: 2048 });
		expect(box).toEqual(referenceBbox);
	});
});

describe('geoBoxCenterAndSize', () => {
	test('computes the center and physical width/height, narrower in longitude-degrees away from the equator', () => {
		const box = { minLon: -93.01, maxLon: -92.99, minLat: 44.99, maxLat: 45.01 };
		const { center, widthMeters, heightMeters } = geoBoxCenterAndSize(box);
		expect(center.lon).toBeCloseTo(-93, 9);
		expect(center.lat).toBeCloseTo(45, 9);
		// Same 0.02-degree span in both axes, but at 45 degrees north a degree of
		// longitude covers fewer meters than a degree of latitude.
		expect(widthMeters).toBeLessThan(heightMeters);
	});
});

describe('planTileGrid', () => {
	test('a 1620m x 1620m area at 300m tile radius plans a centered 3x3 grid spaced 600m apart', () => {
		const center = { lat: 45, lon: -93 };
		const plan = planTileGrid(center, 1620, 1620, 300);
		expect(plan.rows).toBe(3);
		expect(plan.cols).toBe(3);
		expect(plan.tileRadiusMeters).toBe(300);
		expect(plan.centers).toHaveLength(9);
		// Center tile (index 4 of a row-major 3x3) is the plan center itself.
		expect(plan.centers[4].lat).toBeCloseTo(center.lat, 9);
		expect(plan.centers[4].lon).toBeCloseTo(center.lon, 9);
		// Row 0 (northernmost) must be strictly north of row 2 (southernmost).
		expect(plan.centers[0].lat).toBeGreaterThan(plan.centers[6].lat);
		// Col 0 (westernmost) must be strictly west of col 2 (easternmost).
		expect(plan.centers[0].lon).toBeLessThan(plan.centers[2].lon);
	});

	test('a tiny area still plans at least a 1x1 grid', () => {
		const plan = planTileGrid({ lat: 45, lon: -93 }, 10, 10, 300);
		expect(plan.rows).toBe(1);
		expect(plan.cols).toBe(1);
		expect(plan.centers).toEqual([{ lat: 45, lon: -93 }]);
	});

	test('an oversized area is capped at MAX_GRID_ROWS x MAX_GRID_COLS rather than growing unbounded', () => {
		const plan = planTileGrid({ lat: 45, lon: -93 }, 100_000, 100_000, 300);
		expect(plan.rows).toBe(MAX_GRID_ROWS);
		expect(plan.cols).toBe(MAX_GRID_COLS);
		expect(plan.centers).toHaveLength(MAX_GRID_ROWS * MAX_GRID_COLS);
	});

	test('rejects a non-positive tile radius', () => {
		expect(() => planTileGrid({ lat: 45, lon: -93 }, 1000, 1000, 0)).toThrow(/positive/);
	});
});
