import { describe, expect, test } from 'vitest';
import { planHoleGraphic, renderHoleGraphic } from '../../src/lib/holeGraphics';
import type { HoleGraphicRenderEnv } from '../../src/lib/holeGraphics';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
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

/** xTarget = 2*xSource + 100, yTarget = 2*ySource + 50 — an easy-to-check non-identity transform. */
const SCALE_AND_OFFSET: SerializableTransform = {
	...IDENTITY,
	coefficients: [2, 0, 0, 2, 100, 50]
};

describe('planHoleGraphic', () => {
	test('returns null for a hole with no placed features at all', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [] };
		expect(planHoleGraphic(hole, IDENTITY, 1000, 1000)).toBeNull();
	});

	test('transforms tee/basket/shots/corridor and frames a padded, clamped crop', () => {
		const hole: AnnotatedHole = {
			id: 'h1',
			number: 5,
			tee: { xPx: 10, yPx: 10 },
			basket: { xPx: 60, yPx: 40 },
			shots: [{ id: 's1', landing: { xPx: 30, yPx: 20 } }],
			corridor: [
				{ xPx: 5, yPx: 5 },
				{ xPx: 65, yPx: 5 },
				{ xPx: 35, yPx: 45 }
			]
		};

		const plan = planHoleGraphic(hole, SCALE_AND_OFFSET, 1000, 1000);
		expect(plan).not.toBeNull();
		expect(plan!.holeId).toBe('h1');
		expect(plan!.number).toBe(5);
		expect(plan!.tee).toEqual({ xPx: 120, yPx: 70 });
		expect(plan!.basket).toEqual({ xPx: 220, yPx: 130 });
		expect(plan!.shots).toEqual([{ xPx: 160, yPx: 90 }]);
		expect(plan!.corridor).toEqual([
			{ xPx: 110, yPx: 60 },
			{ xPx: 230, yPx: 60 },
			{ xPx: 170, yPx: 140 }
		]);

		// Bounding box of the transformed points: x in [110, 230], y in [60, 140].
		// Span 120 x 80 -> padding = max(40, span*0.2) = 40 x 40 (0.2*120=24 < 40, 0.2*80=16 < 40).
		expect(plan!.crop).toEqual({ xPx: 70, yPx: 20, widthPx: 200, heightPx: 160 });
	});

	test('a single-point hole gets the minimum padding floor, not a zero-size crop', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 500, yPx: 500 } };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		expect(plan!.crop).toEqual({ xPx: 460, yPx: 460, widthPx: 80, heightPx: 80 });
	});

	test('clamps the crop to the target image bounds near an edge', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 5, yPx: 5 } };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		expect(plan!.crop.xPx).toBe(0);
		expect(plan!.crop.yPx).toBe(0);
		expect(plan!.crop.widthPx).toBeLessThanOrEqual(45);
		expect(plan!.crop.heightPx).toBeLessThanOrEqual(45);
	});

	test('a corridor-only hole (no tee/basket/shots) still plans correctly', () => {
		const hole: AnnotatedHole = {
			id: 'h1',
			number: 1,
			shots: [],
			corridor: [
				{ xPx: 0, yPx: 0 },
				{ xPx: 100, yPx: 0 },
				{ xPx: 50, yPx: 100 }
			]
		};
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		expect(plan!.tee).toBeNull();
		expect(plan!.basket).toBeNull();
		expect(plan!.corridor).toHaveLength(3);
	});
});

describe('renderHoleGraphic', () => {
	function fakeEnv(): { env: HoleGraphicRenderEnv; canvas: { width: number; height: number }; calls: string[] } {
		const calls: string[] = [];
		const canvas = { width: 0, height: 0 };
		const context = {
			drawImage: (..._args: unknown[]) => calls.push('drawImage'),
			beginPath: () => calls.push('beginPath'),
			moveTo: () => calls.push('moveTo'),
			lineTo: () => calls.push('lineTo'),
			closePath: () => calls.push('closePath'),
			fill: () => calls.push('fill'),
			stroke: () => calls.push('stroke'),
			arc: () => calls.push('arc'),
			fillRect: () => calls.push('fillRect'),
			fillText: () => calls.push('fillText'),
			measureText: () => ({ width: 40 }),
			setLineDash: () => calls.push('setLineDash'),
			fillStyle: '',
			strokeStyle: '',
			lineWidth: 0,
			font: ''
		};
		const env: HoleGraphicRenderEnv = {
			createCanvas: () => ({ ...canvas, getContext: () => context }) as unknown as HTMLCanvasElement,
			toBlob: async () => new Blob(['hole-graphic'])
		};
		return { env, canvas, calls };
	}

	test('sizes the canvas to the crop and draws the cropped region, corridor, guides, markers, and label', async () => {
		const { env, calls } = fakeEnv();
		const plan = planHoleGraphic(
			{
				id: 'h1',
				number: 3,
				tee: { xPx: 10, yPx: 10 },
				basket: { xPx: 60, yPx: 40 },
				shots: [{ id: 's1', landing: { xPx: 30, yPx: 20 } }],
				corridor: [
					{ xPx: 0, yPx: 0 },
					{ xPx: 70, yPx: 0 },
					{ xPx: 35, yPx: 50 }
				]
			},
			IDENTITY,
			1000,
			1000
		)!;
		const image = {} as HTMLImageElement;

		const blob = await renderHoleGraphic(image, plan, env);

		expect(calls).toContain('drawImage');
		// 1 corridor fill + 3 marker fills (tee, basket, one shot).
		expect(calls.filter((call) => call === 'fill')).toHaveLength(4);
		expect(calls.filter((call) => call === 'arc')).toHaveLength(3); // one per marker
		expect(calls).toContain('fillText'); // hole number label
		expect(blob.size).toBeGreaterThan(0);
	});

	test('skips the corridor draw entirely when absent, without erroring', async () => {
		const { env, calls } = fakeEnv();
		const plan = planHoleGraphic({ id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 } }, IDENTITY, 1000, 1000)!;
		const image = {} as HTMLImageElement;

		await renderHoleGraphic(image, plan, env);

		// One marker (tee) draws exactly one arc+fill; no corridor, no guide line (needs >= 2 points).
		expect(calls.filter((call) => call === 'arc')).toHaveLength(1);
		expect(calls.filter((call) => call === 'moveTo')).toHaveLength(0);
	});

	test('throws a typed error when canvas 2D context allocation fails', async () => {
		const plan = planHoleGraphic({ id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 } }, IDENTITY, 1000, 1000)!;
		const env: HoleGraphicRenderEnv = {
			createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement,
			toBlob: async () => new Blob()
		};
		await expect(renderHoleGraphic({} as HTMLImageElement, plan, env)).rejects.toThrow(/allocate a canvas/);
	});
});
