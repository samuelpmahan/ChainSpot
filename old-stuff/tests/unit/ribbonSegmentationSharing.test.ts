import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../src/lib/autoAnnotation/ribbonMass', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/autoAnnotation/ribbonMass')>();
	return { ...actual, segmentRibbonMass: vi.fn(actual.segmentRibbonMass) };
});

import { segmentRibbonMass, DEFAULT_RIBBON_MASS_PARAMS } from '../../src/lib/autoAnnotation/ribbonMass';
import { deriveP3Ownership } from '../../src/lib/autoAnnotation/rawObjectOwnership';
import { deriveP4RibbonOwnership } from '../../src/lib/autoAnnotation/p4RibbonOwnership';
import { deriveP5SparseAssignment } from '../../src/lib/autoAnnotation/p5SparseAssignment';
import { deriveP6LowParBasketAssignment } from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';
import type { RawMaskBasket, RawMaskTee } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { P2LabeledBadge } from '../../src/lib/autoAnnotation/rawObjectOwnership';

/**
 * Guards the P4/P6.2 single-pass ribbon segmentation cleanup: ribbon
 * segmentation is expensive, so P4 and P6.2 must each accept a caller-
 * supplied segmentation instead of computing their own. If either stage
 * regresses back to calling `segmentRibbonMass` internally, this test's
 * call-count assertion fails.
 */
function syntheticRaster(): { data: Uint8Array; widthPx: number; heightPx: number; channels: 4 } {
	const widthPx = 240;
	const heightPx = 180;
	const data = new Uint8Array(widthPx * heightPx * 4);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const i = (y * widthPx + x) * 4;
			const value = y >= 40 && y < 70 ? 170 + (((x / 6) | 0) % 2 === 0 ? 60 : -30) : 60;
			data[i] = value;
			data[i + 1] = value;
			data[i + 2] = value;
			data[i + 3] = 255;
		}
	}
	return { data, widthPx, heightPx, channels: 4 };
}

const tees: readonly RawMaskTee[] = [
	{ xPx: 10, yPx: 55, orientationDeg: 0, widthPx: 6, heightPx: 6, areaPx: 36, fill: 1 }
];
const badges: readonly P2LabeledBadge[] = [
	{ holeNumber: 1, glyphScore: 0.9, xPx: 120, yPx: 55, widthPx: 20, heightPx: 20 }
];
const baskets: readonly RawMaskBasket[] = [
	{ xPx: 230, yPx: 55, centerXPx: 230, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
];

describe('single-pass ribbon segmentation sharing (P4 + P6.2)', () => {
	beforeEach(() => {
		(segmentRibbonMass as Mock).mockClear();
	});

	it('P4 and P6.2 both accept the same caller-supplied segmentation and neither re-segments', () => {
		const raster = syntheticRaster();

		// The one and only segmentation pass, mirroring the worker's wiring.
		const sharedSegmentation = segmentRibbonMass(
			raster,
			badges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
			DEFAULT_RIBBON_MASS_PARAMS
		);
		expect(segmentRibbonMass).toHaveBeenCalledTimes(1);

		const p3Ownership = deriveP3Ownership(tees, badges, baskets);

		const p4RibbonOwnership = deriveP4RibbonOwnership(
			sharedSegmentation,
			tees,
			badges,
			baskets,
			p3Ownership
		);
		expect(p4RibbonOwnership.holes).toBeInstanceOf(Array);
		expect(segmentRibbonMass).toHaveBeenCalledTimes(1);

		const p5SparseAssignment = deriveP5SparseAssignment(tees, badges, p3Ownership, p4RibbonOwnership);

		const p6Result = deriveP6LowParBasketAssignment(
			{ ...raster, originXPx: 0, originYPx: 0, scale: 1 },
			tees,
			baskets,
			badges,
			p5SparseAssignment,
			p4RibbonOwnership,
			sharedSegmentation
		);
		expect(p6Result.assignments).toBeInstanceOf(Array);
		expect(p6Result.swapAdjudication).toBeDefined();

		// Neither P4 nor P6.2 triggered a second segmentation pass.
		expect(segmentRibbonMass).toHaveBeenCalledTimes(1);
	});
});
