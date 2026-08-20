import { describe, expect, it } from 'vitest';
import {
	addRibbonPoint,
	createEmptyGoldenRibbonHoles,
	createGoldenRibbonSet,
	isRibbonReady,
	moveRibbonPoint,
	parseGoldenRibbonSet,
	removeRibbonPoint,
	ribbonPolygon
} from '../../src/lib/ribbonGolden';

describe('ribbon golden editing', () => {
	it('edits one gutter without mutating the other holes', () => {
		let holes = createEmptyGoldenRibbonHoles();
		holes = addRibbonPoint(holes, 1, 'left', { xPx: 10, yPx: 20 });
		holes = addRibbonPoint(holes, 1, 'left', { xPx: 30, yPx: 40 });
		holes = moveRibbonPoint(holes, 1, 'left', 0, { xPx: 11, yPx: 21 });

		expect(holes[0].leftEdge).toEqual([
			{ xPx: 11, yPx: 21 },
			{ xPx: 30, yPx: 40 }
		]);
		expect(holes[0].rightEdge).toEqual([]);
		expect(holes[1]).toEqual({ number: 2, leftEdge: [], rightEdge: [] });

		holes = removeRibbonPoint(holes, 1, 'left', 0);
		expect(holes[0].leftEdge).toEqual([{ xPx: 30, yPx: 40 }]);
	});

	it('builds the mask polygon as left tee-to-basket plus reversed right', () => {
		const hole = {
			number: 1 as const,
			leftEdge: [
				{ xPx: 0, yPx: 0 },
				{ xPx: 10, yPx: 0 }
			],
			rightEdge: [
				{ xPx: 0, yPx: 5 },
				{ xPx: 10, yPx: 5 }
			]
		};

		expect(ribbonPolygon(hole)).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 },
			{ xPx: 10, yPx: 5 },
			{ xPx: 0, yPx: 5 }
		]);
		expect(isRibbonReady(hole)).toBe(true);
	});

	it('round-trips the JSON contract and preserves source-pixel coordinates', () => {
		let holes = createEmptyGoldenRibbonHoles();
		for (const number of [1, 2, 3] as const) {
			holes = addRibbonPoint(holes, number, 'left', { xPx: 10, yPx: 20 });
			holes = addRibbonPoint(holes, number, 'left', { xPx: 20, yPx: 30 });
			holes = addRibbonPoint(holes, number, 'right', { xPx: 12, yPx: 22 });
			holes = addRibbonPoint(holes, number, 'right', { xPx: 22, yPx: 32 });
		}
		const golden = createGoldenRibbonSet(
			{ fileName: 'course.png', widthPx: 100, heightPx: 80 },
			holes
		);
		const parsed = parseGoldenRibbonSet(JSON.parse(JSON.stringify(golden)));

		expect(parsed).toEqual(golden);
		expect(parsed.coordinateSpace).toBe('source-image-px');
	});

	it('rejects imported points outside the declared source raster', () => {
		const invalid = {
			schemaVersion: 1,
			coordinateSpace: 'source-image-px',
			source: { fileName: 'course.png', widthPx: 100, heightPx: 80 },
			holes: [
				{ number: 1, leftEdge: [{ xPx: 100, yPx: 1 }], rightEdge: [] },
				{ number: 2, leftEdge: [], rightEdge: [] },
				{ number: 3, leftEdge: [], rightEdge: [] }
			]
		};

		expect(() => parseGoldenRibbonSet(invalid)).toThrow(/outside the source image bounds/);
	});
});
