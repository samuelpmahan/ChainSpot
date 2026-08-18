import { describe, expect, test } from 'vitest';
import {
	addTileManifest,
	cellKey,
	cellsRequiredForPixelPoints,
	createIncrementalAerialManifest,
	gridLayout,
	manifestBoundingBox,
	metersPerPixel,
	nextDirectionalCell,
	oldRasterShiftAfterAppend,
	parseIncrementalAerialManifest
} from '../../src/lib/incrementalAerialMosaic';

function seed() {
	return createIncrementalAerialManifest({ lat: 33.18, lon: -96.64 }, 300, 2048);
}

describe('incremental aerial mosaic geometry', () => {
	test('appends cardinal cells without changing fixed ground scale', () => {
		const one = addTileManifest(seed(), { x: 0, y: 0 }, 'usda-naip', '2026-08-18T00:00:00.000Z');
		const east = nextDirectionalCell(one, 'east');
		expect(east).toEqual({ x: 1, y: 0 });
		const two = addTileManifest(one, east, 'usda-naip', '2026-08-18T00:00:01.000Z');
		expect(gridLayout(two)).toMatchObject({ cols: 2, rows: 1, widthPx: 4096, heightPx: 2048 });
		expect(metersPerPixel(two)).toBeCloseTo(600 / 2048, 10);
		expect(oldRasterShiftAfterAppend(one, two)).toEqual({ xPx: 0, yPx: 0 });
	});

	test('west and north growth return the exact translation existing target points need', () => {
		const one = addTileManifest(seed(), { x: 0, y: 0 }, 'usda-naip');
		const west = addTileManifest(one, { x: -1, y: 0 }, 'usda-naip');
		expect(oldRasterShiftAfterAppend(one, west)).toEqual({ xPx: 2048, yPx: 0 });

		const north = addTileManifest(one, { x: 0, y: 1 }, 'usda-naip');
		expect(oldRasterShiftAfterAppend(one, north)).toEqual({ xPx: 0, yPx: 2048 });
	});

	test('turns out-of-bounds target pixels into exact missing tile cells for automatic coverage recovery', () => {
		const one = addTileManifest(seed(), { x: 0, y: 0 }, 'usda-naip');
		const required = cellsRequiredForPixelPoints(one, [
			{ xPx: 500, yPx: 2100 },
			{ xPx: 1400, yPx: 2500 },
			{ xPx: 2100, yPx: 800 },
			{ xPx: -10, yPx: 800 }
		]);
		expect(new Set(required.map(cellKey))).toEqual(new Set(['0,-1', '1,0', '-1,0']));
	});

	test('retains an exact geographic union and round-trips the JSON manifest', () => {
		let manifest = addTileManifest(seed(), { x: 0, y: 0 }, 'usda-naip', '2026-08-18T00:00:00.000Z');
		manifest = addTileManifest(manifest, { x: 1, y: 0 }, 'usda-naip', '2026-08-18T00:00:01.000Z');
		const bounds = manifestBoundingBox(manifest);
		expect(bounds).not.toBeNull();
		expect(bounds!.maxLon).toBeGreaterThan(bounds!.minLon);
		expect(bounds!.maxLat).toBeGreaterThan(bounds!.minLat);

		const parsed = parseIncrementalAerialManifest(JSON.parse(JSON.stringify(manifest)));
		expect(parsed).toEqual(manifest);
	});
});
