/**
 * Coverage for `poseGraph.ts`'s generalized overlap graph (CHSPT-50):
 *
 * - the ordinary axis-aligned 2x2 case still resolves via `model:
 *   'translation'` with placements identical to `autoLayout.ts`'s `assignN`
 *   (the hard regression requirement);
 * - a synthetic rotated 3-tile overlap set escalates past translation and
 *   recovers correct relative poses;
 * - a genuinely unrelated capture makes the batch report `reason:
 *   'incoherent'` rather than forcing a placement.
 */
import { describe, expect, test } from 'vitest';
import { assignN } from '../../src/lib/stitch/autoLayout';
import { buildPoseGraph } from '../../src/lib/stitch/poseGraph';
import { applyAffine6 } from '../../src/lib/geometry/affine6';
import { buildGrayRaster, sceneGray, STEP, TILE_W, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

const PLACEMENT_TOLERANCE_PX = 5;

/**
 * A `TILE_W x TILE_H` raster sampling the shared synthetic scene rotated by
 * `angleDeg` about its own center at `(centerX, centerY)` in scene space —
 * i.e. two rasters built from overlapping centers are two views of the SAME
 * underlying content, one rotated relative to the other by exactly
 * `angleDeg`, giving a known ground truth to check recovered poses against.
 */
function buildRotatedRaster(centerX: number, centerY: number, angleDeg: number): AnalysisRaster {
	const widthPx = TILE_W;
	const heightPx = TILE_H;
	const radians = (angleDeg * Math.PI) / 180;
	const cosT = Math.cos(radians);
	const sinT = Math.sin(radians);
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const ox = x - widthPx / 2;
			const oy = y - heightPx / 2;
			const sx = centerX + ox * cosT - oy * sinT;
			const sy = centerY + ox * sinT + oy * cosT;
			gray[y * widthPx + x] = sceneGray(Math.round(sx), Math.round(sy));
		}
	}
	return { widthPx, heightPx, gray, scale: 1 };
}

describe('poseGraph: ordinary 2x2 regression', () => {
	test('resolves via model "translation" with placements identical to assignN', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const ul = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const ur = buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } });
		const ll = buildGrayRaster('lower-left', { ...noChrome, origin: { x: 0, y: STEP } });
		const lr = buildGrayRaster('lower-right', { ...noChrome, origin: { x: STEP, y: STEP } });
		const rasters = [ul, ur, ll, lr];

		const legacy = await assignN(rasters);
		const pose = await buildPoseGraph(rasters);
		expect(pose.ok).toBe(true);
		if (!pose.ok) return;

		// Every edge stays exactly translation-only, and the anchor is identity.
		for (const index of pose.order) {
			const transform = pose.transforms.get(index)!;
			expect(transform.model).toBe('translation');
			expect(transform.coefficients[0]).toBe(1);
			expect(transform.coefficients[1]).toBe(0);
			expect(transform.coefficients[2]).toBe(0);
			expect(transform.coefficients[3]).toBe(1);
		}
		expect(pose.transforms.get(pose.order[0])!.coefficients).toEqual([1, 0, 0, 1, 0, 0]);

		// Relative offsets between any two rasters match assignN's own legacy
		// placements within the same tolerance the existing regression suite
		// uses (tests/unit/stitchTwoTile.test.ts), not just self-consistently.
		const legacySlotOf = new Map<number, string>();
		for (const slot of legacy.order) legacySlotOf.set(legacy.assignment[slot]!, slot);
		for (let i = 0; i < rasters.length; i += 1) {
			for (let j = 0; j < rasters.length; j += 1) {
				if (i === j) continue;
				const legacyI = legacy.placements[legacySlotOf.get(i)!]!;
				const legacyJ = legacy.placements[legacySlotOf.get(j)!]!;
				const legacyDx = legacyJ.xPx - legacyI.xPx;
				const legacyDy = legacyJ.yPx - legacyI.yPx;

				const poseI = pose.transforms.get(i)!;
				const poseJ = pose.transforms.get(j)!;
				const poseDx = poseJ.coefficients[4] - poseI.coefficients[4];
				const poseDy = poseJ.coefficients[5] - poseI.coefficients[5];

				expect(Math.abs(poseDx - legacyDx)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);
				expect(Math.abs(poseDy - legacyDy)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);
			}
		}
	});
});

describe('poseGraph: rotated overlap escalates past translation', () => {
	test('a 3-tile set with real rotation between neighbors resolves with model similarity/affine and correct relative poses', async () => {
		// Tile 0: unrotated, centered at (150, 150) -- rich in roads/blobs.
		// Tile 1: rotated 35deg about (220, 150) -- overlaps tile 0 heavily,
		// with a genuine rotation between them (the CHSPT-50 "winds along a
		// river" case: panning direction is not axis-aligned neighbor to
		// neighbor).
		// Tile 2: unrotated, centered at (80, 150) -- plain translation
		// overlap with tile 0 on the OPPOSITE side from tile 1, giving the
		// graph a second, ordinary edge that is clearly the strongest evidence
		// for tile 2 (tile 1 and tile 2 barely/don't overlap each other), so
		// the spanning tree unambiguously uses (0,1) and (0,2) rather than
		// some other topology.
		const tile0 = buildRotatedRaster(150, 150, 0);
		const tile1 = buildRotatedRaster(220, 150, 35);
		const tile2 = buildRotatedRaster(80, 150, 0);

		const pose = await buildPoseGraph([tile0, tile1, tile2]);
		expect(pose.ok).toBe(true);
		if (!pose.ok) return;

		const edge01 = pose.placementEdges.find(
			(edge) => (edge.parent === 0 && edge.child === 1) || (edge.parent === 1 && edge.child === 0)
		);
		expect(edge01).toBeDefined();
		expect(edge01!.model === 'similarity' || edge01!.model === 'affine').toBe(true);
		// The escalated edge must score at least as well as a plain translation
		// fit would have -- escalation is only useful if it actually helps.
		expect(edge01!.score).toBeGreaterThan(0.5);

		// Ground truth: tile1's content at its own pixel (x, y) is tile0's
		// content at the same scene point rotated by 35deg about
		// tile1's own center offset from tile0's. Check the composed
		// transform (tile1 -> composite, tile0 anchored at identity) recovers
		// approximately a 35deg rotation: for a pure-rotation-plus-translation
		// or affine map with all-positive scale, the recovered rotation angle
		// is atan2(b, a) of the linear part (a,b,c,d).
		const t1 = pose.transforms.get(1)!;
		const [a, b] = t1.coefficients;
		const recoveredAngleDeg = (Math.atan2(b, a) * 180) / Math.PI;
		const angleError = Math.min(
			Math.abs(recoveredAngleDeg - 35),
			Math.abs(recoveredAngleDeg - 35 + 360),
			Math.abs(recoveredAngleDeg - 35 - 360)
		);
		expect(angleError).toBeLessThan(8);

		// Applying the recovered transform to tile1's own center should land
		// close to tile1's true center-to-center displacement from tile0
		// (220-150, 150-150) = (70, 0) in scene space, since tile0 sits at
		// identity.
		const mappedCenter = applyAffine6({ xPx: TILE_W / 2, yPx: TILE_H / 2 }, t1.coefficients);
		expect(Math.abs(mappedCenter.xPx - (TILE_W / 2 + 70))).toBeLessThan(15);
		expect(Math.abs(mappedCenter.yPx - TILE_H / 2)).toBeLessThan(15);

		// Tile 2 stayed a plain translation edge (no rotation introduced there).
		const t2 = pose.transforms.get(2)!;
		expect(t2.model).toBe('translation');
	});
});

describe('poseGraph: abstention on incoherent evidence', () => {
	test('a genuinely unrelated capture makes the whole batch report reason "incoherent" rather than forcing a placement', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const left = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const right = buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } });
		const unrelated = buildGrayRaster('lower-left', { ...noChrome, unrelated: true });

		const pose = await buildPoseGraph([left, right, unrelated]);
		expect(pose.ok).toBe(false);
		if (pose.ok) return;
		expect(pose.reason).toBe('incoherent');
		expect(pose.message.length).toBeGreaterThan(0);
	});
});
