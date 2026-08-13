import { describe, expect, test } from 'vitest';
import {
	buildHoleGraphicMarkup,
	planHoleGraphic,
	renderHoleGraphicPng,
	zipHoleGraphics
} from '../../src/lib/holeGraphics';
import type { HoleFramingOptions, HoleGraphicRenderEnv } from '../../src/lib/holeGraphics';
import { deriveCorridorBand, deriveCorridorCenterline } from '../../src/lib/corridor';
import type { AnnotatedHole, SourcePoint } from '../../src/lib/domain/annotatedRound';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import { DEFAULT_GRAPHIC_STYLE } from '../../src/lib/graphics/style';

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
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], corridorBends: [], corridorWidthPx: 60 };
		expect(planHoleGraphic(hole, IDENTITY, 1000, 1000)).toBeNull();
	});

	test('transforms tee/basket/shots/centerline/bends and the derived corridor band, and frames a padded in-bounds crop', () => {
		const hole: AnnotatedHole = {
			id: 'h1',
			number: 5,
			tee: { xPx: 10, yPx: 10 },
			basket: { xPx: 60, yPx: 40 },
			shots: [{ id: 's1', landing: { xPx: 30, yPx: 20 } }],
			corridorBends: [{ xPx: 40, yPx: 30 }],
			corridorWidthPx: 20
		};

		const plan = planHoleGraphic(hole, SCALE_AND_OFFSET, 1000, 1000);
		expect(plan).not.toBeNull();
		expect(plan!.holeId).toBe('h1');
		expect(plan!.number).toBe(5);
		expect(plan!.tee).toEqual({ xPx: 120, yPx: 70 });
		expect(plan!.basket).toEqual({ xPx: 220, yPx: 130 });
		expect(plan!.shots).toEqual([{ xPx: 160, yPx: 90 }]);
		expect(plan!.targetWidthPx).toBe(1000);
		expect(plan!.targetHeightPx).toBe(1000);
		// The band is derived from the authoritative centerline + width, then transformed.
		expect(plan!.corridorBand).toEqual(
			deriveCorridorBand(hole)!.map((point) => ({
				xPx: point.xPx * 2 + 100,
				yPx: point.yPx * 2 + 50
			}))
		);
		expect(plan!.centerline).toEqual(
			deriveCorridorCenterline(hole).map((point) => ({
				xPx: point.xPx * 2 + 100,
				yPx: point.yPx * 2 + 50
			}))
		);
		expect(plan!.bends).toEqual([{ xPx: 180, yPx: 110 }]);

		// Crop must frame the derived band as well as the placed points.
		const bandX = plan!.corridorBand!.map((point) => point.xPx);
		const bandY = plan!.corridorBand!.map((point) => point.yPx);
		expect(plan!.crop.xPx).toBeLessThanOrEqual(Math.min(...bandX));
		expect(plan!.crop.xPx + plan!.crop.widthPx).toBeGreaterThanOrEqual(Math.max(...bandX));
		expect(plan!.crop.yPx).toBeLessThanOrEqual(Math.min(...bandY));
		expect(plan!.crop.yPx + plan!.crop.heightPx).toBeGreaterThanOrEqual(Math.max(...bandY));
		expect(plan!.outOfBounds).toBe(false);
	});

	test('a single-point hole gets the minimum padding floor, framed to the default 16:9 aspect ratio', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 500, yPx: 500 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		// Padded bbox is 80x80 (the 40px floor on every side of a single point);
		// height-driven since 80/80 < 16/9, so height stays 80 and width grows to fill 16:9.
		const cropWidth = 80 * (16 / 9);
		expect(plan!.crop.heightPx).toBeCloseTo(80);
		expect(plan!.crop.widthPx).toBeCloseTo(cropWidth);
		expect(plan!.crop.yPx).toBeCloseTo(460);
		expect(plan!.crop.xPx).toBeCloseTo(500 - cropWidth / 2);
		expect(plan!.outOfBounds).toBe(false);
	});

	test('flags an out-of-bounds hole instead of clamping its crop', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 5, yPx: 5 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		// The 40px padding floor alone pushes the padded bbox's top-left negative
		// (5 - 40 = -35); the 16:9 camera only grows from there, so the crop must
		// extend further out of bounds, not get truncated to fit.
		expect(plan!.outOfBounds).toBe(true);
		expect(plan!.crop.xPx).toBeLessThan(0);
		expect(plan!.crop.yPx).toBeLessThan(0);
	});

	test('a non-default framing option changes the plan crop', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 500, yPx: 500 }, corridorBends: [], corridorWidthPx: 60 };
		// A square (1:1) aspect keeps this specific case's numbers simple to assert exactly.
		const tightFraming: HoleFramingOptions = { paddingFraction: 0.2, minPaddingPx: 5, aspectRatio: 1 };

		const defaultPlan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		const tightPlan = planHoleGraphic(hole, IDENTITY, 1000, 1000, tightFraming);

		const defaultCropWidth = 80 * (16 / 9);
		expect(defaultPlan!.crop.heightPx).toBeCloseTo(80);
		expect(defaultPlan!.crop.widthPx).toBeCloseTo(defaultCropWidth);
		expect(tightPlan!.crop).toEqual({ xPx: 495, yPx: 495, widthPx: 10, heightPx: 10 });
		expect(tightPlan!.crop).not.toEqual(defaultPlan!.crop);
	});

	test('a bends-only hole (no tee/basket/shots) cannot frame a crop and plans to null', () => {
		const hole: AnnotatedHole = {
			id: 'h1',
			number: 1,
			shots: [],
			corridorBends: [
				{ xPx: 0, yPx: 0 },
				{ xPx: 100, yPx: 0 },
				{ xPx: 50, yPx: 100 }
			],
			corridorWidthPx: 60
		};
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		expect(plan).toBeNull();
	});

	test('defaults to an empty walkingPath when none is supplied', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		expect(plan!.walkingPath).toEqual([]);
	});

	test('transforms the walking path through the same transform as every other feature', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 };
		const walkingPath: SourcePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 20, yPx: 30 }
		];
		const plan = planHoleGraphic(hole, SCALE_AND_OFFSET, 1000, 1000, undefined, walkingPath);
		expect(plan!.walkingPath).toEqual([
			{ xPx: 100, yPx: 50 },
			{ xPx: 140, yPx: 110 }
		]);
	});

	test('the walking path never affects crop framing', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 500, yPx: 500 }, corridorBends: [], corridorWidthPx: 60 };
		const withoutPath = planHoleGraphic(hole, IDENTITY, 1000, 1000);
		const withPath = planHoleGraphic(hole, IDENTITY, 1000, 1000, undefined, [
			{ xPx: 0, yPx: 0 },
			{ xPx: 999, yPx: 999 }
		]);
		expect(withPath!.crop).toEqual(withoutPath!.crop);
	});

	test('a hole with no other placed feature still plans to null even with a walking path supplied', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000, undefined, [
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 100 }
		]);
		expect(plan).toBeNull();
	});
});

describe('buildHoleGraphicMarkup', () => {
	function planFor(hole: AnnotatedHole): ReturnType<typeof planHoleGraphic> {
		return planHoleGraphic(hole, IDENTITY, 1000, 1000);
	}

	test('crops via viewBox and references the target image href directly (no pixel copy)', () => {
		const plan = planFor({
			id: 'h1',
			number: 3,
			tee: { xPx: 10, yPx: 10 },
			basket: { xPx: 60, yPx: 40 },
			shots: [{ id: 's1', landing: { xPx: 30, yPx: 20 } }],
			corridorBends: [],
			corridorWidthPx: 20
		})!;

		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/target');

		expect(markup).toContain(`viewBox="${plan.crop.xPx} ${plan.crop.yPx} ${plan.crop.widthPx} ${plan.crop.heightPx}"`);
		expect(markup).toContain('href="blob:http://example/target"');
		expect(markup).toContain('width="1000" height="1000"'); // full target dims, not the crop
		expect(markup).toContain('<polygon'); // corridor band
		expect(markup).toContain('<polyline'); // centerline and/or guide
		expect(markup).toContain('Hole 3');
	});

	test('escapes the href so a URL cannot break out of the attribute', () => {
		const plan = planFor({ id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 })!;
		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/"><script>alert(1)</script>');
		expect(markup).not.toContain('<script>');
		expect(markup).toContain('&quot;&gt;&lt;script&gt;');
	});

	test('skips the corridor and centerline entirely when absent, without erroring', () => {
		const plan = planFor({ id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 })!;
		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/target');
		expect(markup).not.toContain('<polygon');
		expect(markup).not.toContain('<polyline');
	});

	test('renders the walking path with the style preset color when present', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000, undefined, [
			{ xPx: 5, yPx: 5 },
			{ xPx: 995, yPx: 995 }
		])!;
		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/target', DEFAULT_GRAPHIC_STYLE);
		expect(markup).toContain(
			`<polyline points="5,5 995,995" fill="none" stroke="${DEFAULT_GRAPHIC_STYLE.walkingPathColor}"`
		);
		expect(markup).toContain('stroke-linejoin="round"');
		expect(markup).toContain('stroke-linecap="round"');
	});

	test('omits the walking path element entirely when absent', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000)!;
		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/target', DEFAULT_GRAPHIC_STYLE);
		expect(markup).not.toContain(DEFAULT_GRAPHIC_STYLE.walkingPathColor);
	});

	test('a single-point walking path renders no polyline (nothing to connect)', () => {
		const hole: AnnotatedHole = { id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 };
		const plan = planHoleGraphic(hole, IDENTITY, 1000, 1000, undefined, [{ xPx: 5, yPx: 5 }])!;
		const markup = buildHoleGraphicMarkup(plan, 'blob:http://example/target', DEFAULT_GRAPHIC_STYLE);
		expect(markup).not.toContain(DEFAULT_GRAPHIC_STYLE.walkingPathColor);
	});
});

describe('renderHoleGraphicPng', () => {
	function fakeEnv(): { env: HoleGraphicRenderEnv; calls: string[] } {
		const calls: string[] = [];
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({
				drawImage: (..._args: unknown[]) => calls.push('drawImage')
			})
		};
		const env: HoleGraphicRenderEnv = {
			createCanvas: () => canvas as unknown as HTMLCanvasElement,
			toBlob: async () => {
				calls.push('toBlob');
				return new Blob(['hole-graphic']);
			},
			loadImage: async (url) => {
				calls.push(`loadImage:${url.startsWith('data:image/svg+xml') ? 'svg' : url}`);
				return { width: 10, height: 10 } as unknown as CanvasImageSource & { width: number; height: number };
			}
		};
		return { env, calls };
	}

	test('rasterizes the built SVG markup onto a canvas sized to the crop', async () => {
		const { env, calls } = fakeEnv();
		const plan = planHoleGraphic(
			{ id: 'h1', number: 3, tee: { xPx: 10, yPx: 10 }, basket: { xPx: 60, yPx: 40 }, shots: [], corridorBends: [], corridorWidthPx: 20 },
			IDENTITY,
			1000,
			1000
		)!;

		const blob = await renderHoleGraphicPng('blob:http://example/target', plan, env);

		expect(calls).toEqual(['loadImage:svg', 'drawImage', 'toBlob']);
		expect(blob.size).toBeGreaterThan(0);
	});

	test('throws a typed error when canvas 2D context allocation fails', async () => {
		const plan = planHoleGraphic(
			{ id: 'h1', number: 1, shots: [], tee: { xPx: 10, yPx: 10 }, corridorBends: [], corridorWidthPx: 60 },
			IDENTITY,
			1000,
			1000
		)!;
		const env: HoleGraphicRenderEnv = {
			createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement,
			toBlob: async () => new Blob(),
			loadImage: async () => ({ width: 10, height: 10 }) as unknown as CanvasImageSource & { width: number; height: number }
		};
		await expect(renderHoleGraphicPng('blob:http://example/target', plan, env)).rejects.toThrow(/allocate a canvas/);
	});
});

describe('zipHoleGraphics', () => {
	test('names entries hole-01.png..hole-NN.png inside a single zip blob', async () => {
		const zip = await zipHoleGraphics([
			{ number: 1, blob: new Blob(['a']) },
			{ number: 12, blob: new Blob(['b']) }
		]);
		expect(zip.type).toBe('application/zip');
		const { unzipSync } = await import('fflate');
		const bytes = new Uint8Array(await zip.arrayBuffer());
		const files = unzipSync(bytes);
		expect(Object.keys(files).sort()).toEqual(['hole-01.png', 'hole-12.png']);
	});
});
