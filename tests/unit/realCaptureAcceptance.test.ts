/**
 * End-to-end acceptance test for the product's core promise: four real phone
 * screenshots of a disc-golf course map, stitched correctly, automatically.
 *
 * Everything else in the suite exercises `assignFour` against synthetic
 * fixtures. This is the one test that runs the actual OpenCV `matchTemplate`
 * matcher against the actual real capture and checks its output against an
 * independently-established ground truth (`tests/helpers/realCapture.js`,
 * derived by a brute-force ZNCC search that shares no code with the shipped
 * matcher). Nothing else in the repo proves the rewritten matcher actually
 * works end to end; this test IS that proof.
 *
 * The real capture is the user's own screenshots (including a personal GPS
 * track) and is deliberately gitignored, so it is absent on a fresh clone or
 * in CI. `describe.skipIf(!available())` lets those environments stay green
 * without silently deleting the coverage — a developer with the capture in
 * `resources/real-capture/` gets the real regression check.
 */
import { describe, expect, test } from 'vitest';
import { assignFour } from '../../src/lib/stitch/autoLayout';
import { snapAlign } from '../../src/lib/stitch/cvMatch';
import type { SnapNeighbor } from '../../src/lib/stitch/cvMatch';
import { available, loadCroppedTiles, REAL_CAPTURE_GROUND_TRUTH } from '../helpers/realCapture.js';

// Placement tolerance in pixels, on each axis independently. Generous enough
// to absorb sub-pixel search-grid and pyramid-refinement jitter between the
// shipped matcher and the brute-force oracle, tight enough that a real
// regression (wrong edge, swapped tile, off-by-one orientation) still fails.
const TOLERANCE_PX = 4;

type Slot2x2 = 'upper-left' | 'upper-right' | 'lower-left' | 'lower-right';

// Deliberately not upper-left first: file-selection order must not determine
// the result. This is the true slot for each array index.
const SCRAMBLED_ORDER: readonly Slot2x2[] = [
	'lower-right',
	'upper-left',
	'lower-left',
	'upper-right'
];

describe.skipIf(!available())('real capture acceptance', () => {
	test(
		'assignFour recovers the correct slots and placements for the real capture, regardless of input order',
		async () => {
			const tiles = loadCroppedTiles();
			const rasters = SCRAMBLED_ORDER.map((slot) => ({ ...tiles[slot], scale: 1 }));

			const layout = await assignFour(rasters);

			for (const slot of SCRAMBLED_ORDER) {
				const expectedIndex = SCRAMBLED_ORDER.indexOf(slot);
				expect(layout.assignment[slot]).toBe(expectedIndex);
			}

			for (const slot of Object.keys(REAL_CAPTURE_GROUND_TRUTH.placements) as Slot2x2[]) {
				const expected = REAL_CAPTURE_GROUND_TRUTH.placements[slot];
				const actual = layout.placements[slot];
				if (!actual) throw new Error(`expected a placement for ${slot}`);
				expect(actual.xPx).toBeGreaterThanOrEqual(expected.xPx - TOLERANCE_PX);
				expect(actual.xPx).toBeLessThanOrEqual(expected.xPx + TOLERANCE_PX);
				expect(actual.yPx).toBeGreaterThanOrEqual(expected.yPx - TOLERANCE_PX);
				expect(actual.yPx).toBeLessThanOrEqual(expected.yPx + TOLERANCE_PX);
			}

			// P1-002 1b: Snap now shares this same `cvMatch` matcher instead of the
			// old hand-rolled MAD search, so its two invariants are mirrored here
			// against the real capture's own ground truth (independent of
			// `assignFour`'s four-tile assignment above — Snap only ever needs a
			// tile plus its already-placed neighbors).
			const groundTruth = REAL_CAPTURE_GROUND_TRUTH.placements;
			const tileFor = (slot: Slot2x2) => ({ ...tiles[slot], scale: 1 });
			const neighborsFor = (slots: readonly Slot2x2[]): SnapNeighbor[] =>
				slots.map((slot) => ({
					raster: tileFor(slot),
					xPx: groundTruth[slot].xPx,
					yPx: groundTruth[slot].yPx
				}));

			// (a) Negative-direction displacement recovers ground truth (regression
			// insurance for the old matcher's directional tie-break bias;
			// structurally impossible with the cvMatch-backed matcher, but pinned
			// here regardless).
			const displaced = await snapAlign(
				tileFor('upper-right'),
				neighborsFor(['upper-left', 'lower-right']),
				groundTruth['upper-right'].xPx - 15,
				groundTruth['upper-right'].yPx - 11
			);
			expect(Math.abs(displaced.xPx - groundTruth['upper-right'].xPx)).toBeLessThanOrEqual(
				TOLERANCE_PX
			);
			expect(Math.abs(displaced.yPx - groundTruth['upper-right'].yPx)).toBeLessThanOrEqual(
				TOLERANCE_PX
			);

			// (b) Snap from exact ground truth must never move the tile — the core
			// "Snap must never make alignment worse" invariant, checked at a tight
			// (1px) tolerance.
			const exact = await snapAlign(
				tileFor('lower-left'),
				neighborsFor(['upper-left', 'lower-right']),
				groundTruth['lower-left'].xPx,
				groundTruth['lower-left'].yPx
			);
			expect(Math.abs(exact.xPx - groundTruth['lower-left'].xPx)).toBeLessThanOrEqual(1);
			expect(Math.abs(exact.yPx - groundTruth['lower-left'].yPx)).toBeLessThanOrEqual(1);
		},
		120000
	);
});
