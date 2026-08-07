import { describe, expect, test } from 'vitest';
import { createAnnotatedRound, MIN_CENTERLINE_POINTS } from '../../src/lib/domain/annotatedRound';
import type { AnnotatedSourceImage } from '../../src/lib/domain/annotatedRound';
import { planHoleGraphic } from '../../src/lib/holeGraphics';
import type { SerializableTransform } from '../../src/lib/alignment/types';

const IDENTITY: SerializableTransform = {
	model: 'similarity',
	coefficients: [1, 0, 0, 1, 0, 0],
	isInvertible: true,
	determinant: 1,
	orientation: 1,
	majorAxisScale: 1,
	minorAxisScale: 1,
	anisotropy: 1,
	shear: 0
};

function sourceImage(): AnnotatedSourceImage {
	return {
		fileName: 'course.png',
		mimeType: 'image/png',
		widthPx: 500,
		heightPx: 500,
		blob: new Blob(['course'], { type: 'image/png' })
	};
}

describe('authoritative hole centerlines', () => {
	test('accepts an in-bounds tee-to-basket polyline and preserves it verbatim', () => {
		const centerline = [
			{ xPx: 20, yPx: 400 },
			{ xPx: 150, yPx: 250 },
			{ xPx: 420, yPx: 80 }
		];
		const round = createAnnotatedRound({
			sourceImage: sourceImage(),
			holes: [{ id: 'h7', number: 7, shots: [], centerline }]
		});
		expect(round.holes[0].centerline).toBe(centerline);
	});

	test('rejects a one-point or out-of-bounds centerline', () => {
		expect(() =>
			createAnnotatedRound({
				sourceImage: sourceImage(),
				holes: [{ id: 'h1', number: 1, shots: [], centerline: [{ xPx: 20, yPx: 20 }] }]
			})
		).toThrow(new RegExp(`at least ${MIN_CENTERLINE_POINTS}`));
		expect(() =>
			createAnnotatedRound({
				sourceImage: sourceImage(),
				holes: [
					{
						id: 'h1',
						number: 1,
						shots: [],
						centerline: [
							{ xPx: 20, yPx: 20 },
							{ xPx: 999, yPx: 20 }
						]
					}
				]
			})
		).toThrow(/centerline point 2/);
	});

	test('transforms the centerline into target space and lets it define the crop', () => {
		const plan = planHoleGraphic(
			{
				id: 'h4',
				number: 4,
				shots: [],
				centerline: [
					{ xPx: 100, yPx: 100 },
					{ xPx: 200, yPx: 150 },
					{ xPx: 300, yPx: 300 }
				]
			},
			IDENTITY,
			500,
			500
		);
		expect(plan).not.toBeNull();
		expect(plan!.centerline).toEqual([
			{ xPx: 100, yPx: 100 },
			{ xPx: 200, yPx: 150 },
			{ xPx: 300, yPx: 300 }
		]);
		expect(plan!.crop).toEqual({ xPx: 60, yPx: 60, widthPx: 280, heightPx: 280 });
	});
});
