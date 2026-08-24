import { describe, expect, test } from 'vitest';
import { projectToComposite } from '@chainspot/alg/g0/projection';

describe('projectToComposite', () => {
	test('with no insets and no placement, returns the point unchanged', () => {
		expect(projectToComposite({ xPx: 40, yPx: 30 }, null)).toEqual({ xPx: 40, yPx: 30 });
	});

	test('subtracts crop insets to get crop-adjusted tile-local coordinates', () => {
		const insets = { top: 5, right: 0, bottom: 0, left: 10 };
		expect(projectToComposite({ xPx: 40, yPx: 30 }, insets)).toEqual({ xPx: 30, yPx: 25 });
	});

	test('adds the tile placement on top of the crop adjustment for full composite-space coordinates', () => {
		const insets = { top: 5, right: 0, bottom: 0, left: 10 };
		const placement = { x: 200, y: 100 };
		expect(projectToComposite({ xPx: 40, yPx: 30 }, insets, placement)).toEqual({ xPx: 230, yPx: 125 });
	});

	test('matches the page formula: placements[i].x + (e.xPx - left), placements[i].y + (e.yPx - top)', () => {
		// this is the exact duplicated formula from projectMarkers()/enterAnnotate()
		const left = 12;
		const top = 34;
		const placement = { x: 500, y: 300 };
		const point = { xPx: 77, yPx: 88 };

		const expected = { xPx: placement.x + (point.xPx - left), yPx: placement.y + (point.yPx - top) };
		expect(projectToComposite(point, { top, right: 0, bottom: 0, left }, placement)).toEqual(expected);
	});
});
