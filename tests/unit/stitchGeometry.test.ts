import { describe, expect, test } from 'vitest';
import {
	TILE_SLOTS,
	ZERO_CROP,
	cropSize,
	expectedNeighbors,
	initialPlacements,
	overlapArea,
	readiness,
	sessionDimensions,
	tileRect,
	translatedOrigin,
	unionBounds
} from '../../src/lib/stitch/geometry';
import type { CropInsets, TilePlacement, TileSlot } from '../../src/lib/stitch/geometry';

function tilesOf(
	dims: Partial<Record<TileSlot, { widthPx: number; heightPx: number }>>
): Partial<Record<TileSlot, { widthPx: number; heightPx: number }>> {
	return { ...dims };
}

function placementsOf(
	positions: Partial<Record<TileSlot, { xPx: number; yPx: number }>>
): Record<TileSlot, TilePlacement> {
	const base = initialPlacements(100, 80);
	for (const slot of TILE_SLOTS) {
		const position = positions[slot];
		if (position) base[slot] = { ...base[slot], xPx: position.xPx, yPx: position.yPx };
	}
	return base;
}

describe('stitch geometry (P05-002)', () => {
	test('contract: crop validation, initial placement, readiness, and union translation', () => {
		// --- Shared crop: valid insets produce the cropped size ---
		const valid = cropSize({ topPx: 10, rightPx: 20, bottomPx: 30, leftPx: 40 }, 1000, 800);
		expect(valid).toEqual({ ok: true, widthPx: 940, heightPx: 760 });

		// --- Individual inset rejection, with the offending field identified ---
		const negative = cropSize({ ...ZERO_CROP, topPx: -1 }, 100, 100);
		if (negative.ok) throw new Error('expected rejection');
		expect(negative.invalidFields).toEqual(['topPx']);

		const fractional = cropSize({ ...ZERO_CROP, rightPx: 1.5 }, 100, 100);
		if (fractional.ok) throw new Error('expected rejection');
		expect(fractional.invalidFields).toEqual(['rightPx']);

		const nonFinite = cropSize({ ...ZERO_CROP, bottomPx: Number.NaN }, 100, 100);
		if (nonFinite.ok) throw new Error('expected rejection');
		expect(nonFinite.invalidFields).toEqual(['bottomPx']);

		// --- Pair rejection flags both horizontal / both vertical fields ---
		const horizontal = cropSize({ ...ZERO_CROP, leftPx: 600, rightPx: 500 }, 1000, 800);
		if (horizontal.ok) throw new Error('expected rejection');
		expect(horizontal.invalidFields).toEqual(['leftPx', 'rightPx']);

		const vertical = cropSize({ ...ZERO_CROP, topPx: 500, bottomPx: 400 }, 1000, 800);
		if (vertical.ok) throw new Error('expected rejection');
		expect(vertical.invalidFields).toEqual(['topPx', 'bottomPx']);

		// --- Initial placement: documented 25% offsets, always integers ---
		const initial = initialPlacements(1000, 800);
		expect(initial['upper-left']).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(initial['upper-right'].xPx).toBe(750);
		expect(initial['upper-right'].yPx).toBe(0);
		expect(initial['lower-left'].xPx).toBe(0);
		expect(initial['lower-left'].yPx).toBe(600);
		expect(initial['lower-right']).toEqual({ xPx: 750, yPx: 600, visible: true });

		// Rounding case: 0.75 products that are fractional must be rounded, not kept.
		const rounded = initialPlacements(1002, 802);
		expect(rounded['upper-right'].xPx).toBe(752);
		expect(rounded['lower-left'].yPx).toBe(602);

		// --- Expected neighbors per slot ---
		expect(expectedNeighbors('upper-left')).toEqual(['upper-right', 'lower-left']);
		expect(expectedNeighbors('upper-right')).toEqual(['upper-left', 'lower-right']);
		expect(expectedNeighbors('lower-left')).toEqual(['upper-left', 'lower-right']);
		expect(expectedNeighbors('lower-right')).toEqual(['upper-right', 'lower-left']);

		// --- Overlap area ---
		const rectA = tileRect({ xPx: 0, yPx: 0, visible: true }, 100, 80);
		const rectB = tileRect({ xPx: 75, yPx: 0, visible: true }, 100, 80);
		expect(overlapArea(rectA, rectB)).toBe(2000);
		const rectC = tileRect({ xPx: 500, yPx: 500, visible: true }, 100, 80);
		expect(overlapArea(rectA, rectC)).toBe(0);

		// --- Readiness: all valid ---
		const allTiles = tilesOf({
			'upper-left': { widthPx: 100, heightPx: 80 },
			'upper-right': { widthPx: 100, heightPx: 80 },
			'lower-left': { widthPx: 100, heightPx: 80 },
			'lower-right': { widthPx: 100, heightPx: 80 }
		});
		const required = sessionDimensions(allTiles);
		expect(required).toEqual({ widthPx: 100, heightPx: 80 });
		expect(readiness(allTiles, ZERO_CROP, initialPlacements(100, 80), required).ready).toBe(true);

		// --- Missing tile ---
		const missingRight = tilesOf(allTiles);
		delete missingRight['upper-right'];
		expect(readiness(missingRight, ZERO_CROP, initialPlacements(100, 80), required).missing).toEqual([
			'upper-right'
		]);

		// --- Dimension mismatch against the established requirement ---
		const mismatched = { ...allTiles, 'upper-right': { widthPx: 101, heightPx: 80 } };
		expect(readiness(mismatched, ZERO_CROP, initialPlacements(100, 80), required).dimensionMismatch).toEqual([
			'upper-right'
		]);

		// --- Invalid crop ---
		const invalidCrop: CropInsets = { ...ZERO_CROP, leftPx: 60, rightPx: 60 };
		expect(readiness(allTiles, invalidCrop, initialPlacements(100, 80), required).invalidCrop).toBe(true);

		// --- Missing expected-neighbor overlap ---
		const drifted = placementsOf({
			'upper-right': { xPx: 500, yPx: 0 },
			'lower-left': { xPx: 0, yPx: 500 }
		});
		const driftedReport = readiness(allTiles, ZERO_CROP, drifted, required);
		expect(driftedReport.ready).toBe(false);
		expect(driftedReport.noOverlap).toEqual(['upper-right', 'lower-left', 'lower-right']);

		// --- Session dimensions: first valid tile in slot order establishes them ---
		expect(sessionDimensions({})).toBeNull();
		expect(sessionDimensions({ 'lower-left': { widthPx: 20, heightPx: 21 } })).toEqual({
			widthPx: 20,
			heightPx: 21
		});
		expect(
			sessionDimensions({ 'upper-left': { widthPx: 10, heightPx: 11 }, 'lower-left': { widthPx: 20, heightPx: 21 } })
		).toEqual({ widthPx: 10, heightPx: 11 });

		// --- Union bounds and translation to origin ---
		const union = unionBounds([
			tileRect({ xPx: 0, yPx: 0, visible: true }, 100, 80),
			tileRect({ xPx: 75, yPx: 0, visible: true }, 100, 80),
			tileRect({ xPx: 0, yPx: 60, visible: true }, 100, 80),
			tileRect({ xPx: 75, yPx: 60, visible: true }, 100, 80)
		]);
		expect(union).toEqual({ xPx: 0, yPx: 0, widthPx: 175, heightPx: 140 });
		expect(translatedOrigin(union!)).toEqual({ dxPx: 0, dyPx: 0 });

		const negativeUnion = unionBounds([
			tileRect({ xPx: -10, yPx: -5, visible: true }, 100, 80),
			tileRect({ xPx: -35, yPx: -5, visible: true }, 100, 80)
		]);
		expect(negativeUnion).toEqual({ xPx: -35, yPx: -5, widthPx: 125, heightPx: 80 });
		expect(translatedOrigin(negativeUnion!)).toEqual({ dxPx: 35, dyPx: 5 });
		expect(unionBounds([])).toBeNull();
	});
});
