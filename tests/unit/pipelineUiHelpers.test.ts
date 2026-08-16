import { describe, expect, test } from 'vitest';
import { badgeFlashPercent, buildManualDraftComposite } from '../../src/lib/stitch/pipelineUiHelpers';
import { ZERO_CROP } from '../../src/lib/stitch/geometry';
import type { CropInsets, TilePlacement, TileSlot } from '../../src/lib/stitch/geometry';

describe('badgeFlashPercent', () => {
	test('maps an anchor box to the percentage position of its center', () => {
		expect(badgeFlashPercent({ xPx: 100, yPx: 200, widthPx: 40, heightPx: 20 }, 1000, 500)).toEqual({
			leftPct: 12, // (100 + 20) / 1000 * 100
			topPct: 42 // (200 + 10) / 500 * 100
		});
	});

	test('is exact at the composite corners', () => {
		expect(badgeFlashPercent({ xPx: 0, yPx: 0, widthPx: 0, heightPx: 0 }, 200, 100)).toEqual({
			leftPct: 0,
			topPct: 0
		});
		expect(badgeFlashPercent({ xPx: 200, yPx: 100, widthPx: 0, heightPx: 0 }, 200, 100)).toEqual({
			leftPct: 100,
			topPct: 100
		});
	});

	test('never divides by zero for a degenerate output size', () => {
		expect(badgeFlashPercent({ xPx: 10, yPx: 10, widthPx: 4, heightPx: 4 }, 0, 0)).toEqual({
			leftPct: 0,
			topPct: 0
		});
	});
});

const TILE = { fileName: 'a.png', mimeType: 'image/png', widthPx: 100, heightPx: 100 };

describe('buildManualDraftComposite', () => {
	test('returns null with no placed tiles', () => {
		expect(
			buildManualDraftComposite({
				slots: [],
				tiles: {},
				placements: {},
				crop: ZERO_CROP,
				hashesBySlot: new Map(),
				cropTouched: false,
				transformTouchedSlots: new Set()
			})
		).toBeNull();
	});

	test('returns null for an invalid shared crop', () => {
		const invalidCrop: CropInsets = { topPx: 0, rightPx: 60, bottomPx: 0, leftPx: 60 };
		expect(
			buildManualDraftComposite({
				slots: ['tile-0'],
				tiles: { 'tile-0': TILE },
				placements: { 'tile-0': { xPx: 0, yPx: 0, visible: true } },
				crop: invalidCrop,
				hashesBySlot: new Map(),
				cropTouched: false,
				transformTouchedSlots: new Set()
			})
		).toBeNull();
	});

	test('builds a single-source draft with an identity-origin translation, a placeholder hash when none is supplied, and an all-automatic origin when nothing was touched', () => {
		const draft = buildManualDraftComposite({
			slots: ['tile-0'],
			tiles: { 'tile-0': TILE },
			placements: { 'tile-0': { xPx: 0, yPx: 0, visible: true } },
			crop: ZERO_CROP,
			hashesBySlot: new Map(),
			cropTouched: false,
			transformTouchedSlots: new Set()
		});
		expect(draft).not.toBeNull();
		expect(draft!.compositingPolicy).toBe('single-source-v1');
		expect(draft!.outputWidthPx).toBe(100);
		expect(draft!.outputHeightPx).toBe(100);
		expect(draft!.sources).toHaveLength(1);
		const source = draft!.sources[0];
		expect(source.paintOrder).toBe(0);
		expect(source.transform.model).toBe('translation');
		expect(source.transform.coefficients).toEqual([1, 0, 0, 1, 0, 0]);
		expect(source.sha256).toBe('0'.repeat(64));
		expect(source.origin).toEqual({ crop: 'auto', transform: 'auto' });
		expect(source.coveragePolygon).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 0 },
			{ xPx: 100, yPx: 100 },
			{ xPx: 0, yPx: 100 }
		]);
	});

	test('translates every tile transform by the union origin, orders paint ascending bottom-right, and uses supplied hashes', () => {
		const slots: TileSlot[] = ['tile-0', 'tile-1'];
		const placements: Partial<Record<TileSlot, TilePlacement>> = {
			'tile-0': { xPx: 0, yPx: 0, visible: true },
			// Anchor tile sits at a negative offset relative to the other tile, so
			// the union's top-left is NOT the origin — this is the case that
			// exercises `translatedOrigin`.
			'tile-1': { xPx: -10, yPx: 5, visible: true }
		};
		const hashesBySlot = new Map([
			['tile-0', 'a'.repeat(64)],
			['tile-1', 'b'.repeat(64)]
		]);
		const draft = buildManualDraftComposite({
			slots,
			tiles: { 'tile-0': TILE, 'tile-1': TILE },
			placements,
			crop: ZERO_CROP,
			hashesBySlot,
			cropTouched: false,
			transformTouchedSlots: new Set()
		});
		expect(draft).not.toBeNull();
		expect(draft!.compositingPolicy).toBe('stitch-ascending-bottom-right-v1');
		// Union spans x [-10, 100), y [0, 105) -> 110 x 105.
		expect(draft!.outputWidthPx).toBe(110);
		expect(draft!.outputHeightPx).toBe(105);

		const bySlot = new Map(draft!.sources.map((source) => [source.sourceId, source]));
		const tile0 = bySlot.get('tile-0')!;
		const tile1 = bySlot.get('tile-1')!;
		// dxPx = 10, dyPx = 0 (translatedOrigin negates the union's min corner).
		expect(tile0.transform.coefficients.slice(4)).toEqual([10, 0]);
		expect(tile1.transform.coefficients.slice(4)).toEqual([0, 5]);
		expect(tile0.sha256).toBe('a'.repeat(64));
		expect(tile1.sha256).toBe('b'.repeat(64));

		// tile-1's own placement sum (-10 + 5 = -5) is lower than tile-0's (0),
		// so tile-1 paints first.
		expect(tile1.paintOrder).toBe(0);
		expect(tile0.paintOrder).toBe(1);
	});

	describe('origin tracking (CHSPT-49/55 SourceCaptureOrigin)', () => {
		const slots: TileSlot[] = ['tile-0', 'tile-1'];
		const placements: Partial<Record<TileSlot, TilePlacement>> = {
			'tile-0': { xPx: 0, yPx: 0, visible: true },
			'tile-1': { xPx: 100, yPx: 0, visible: true }
		};
		const tiles = { 'tile-0': TILE, 'tile-1': TILE };

		test('a touched shared crop marks every source manual for crop but leaves transform automatic', () => {
			const draft = buildManualDraftComposite({
				slots,
				tiles,
				placements,
				crop: ZERO_CROP,
				hashesBySlot: new Map(),
				cropTouched: true,
				transformTouchedSlots: new Set()
			});
			for (const source of draft!.sources) {
				expect(source.origin).toEqual({ crop: 'manual', transform: 'auto' });
			}
		});

		test('a touched placement marks only that source manual for transform, leaving its neighbor untouched', () => {
			const draft = buildManualDraftComposite({
				slots,
				tiles,
				placements,
				crop: ZERO_CROP,
				hashesBySlot: new Map(),
				cropTouched: false,
				transformTouchedSlots: new Set(['tile-1'])
			});
			const bySlot = new Map(draft!.sources.map((source) => [source.sourceId, source]));
			expect(bySlot.get('tile-0')!.origin).toEqual({ crop: 'auto', transform: 'auto' });
			expect(bySlot.get('tile-1')!.origin).toEqual({ crop: 'auto', transform: 'manual' });
		});

		test('both a touched crop and a touched placement compose to a fully manual origin for the touched source', () => {
			const draft = buildManualDraftComposite({
				slots,
				tiles,
				placements,
				crop: ZERO_CROP,
				hashesBySlot: new Map(),
				cropTouched: true,
				transformTouchedSlots: new Set(['tile-0'])
			});
			const bySlot = new Map(draft!.sources.map((source) => [source.sourceId, source]));
			expect(bySlot.get('tile-0')!.origin).toEqual({ crop: 'manual', transform: 'manual' });
			expect(bySlot.get('tile-1')!.origin).toEqual({ crop: 'manual', transform: 'auto' });
		});
	});
});
