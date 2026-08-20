import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS,
	buildModernCorridorEvidence
} from '../../src/lib/autoAnnotation/corridorEvidenceGridRibbonMass';
import type { RibbonMassSegmentationForEvidence } from '../../src/lib/autoAnnotation/corridorEvidenceGridRibbonMass';
import { labelComponents } from '../../src/lib/autoAnnotation/ribbonMass';
import type { SourcePoint } from '../../src/lib/domain/project';

/**
 * Builds a synthetic `RibbonMassSegmentation`-shaped object by painting a
 * binary open/closed grid (for connected-component labels, via the real
 * exported `labelComponents`) and a separately-specified graded evidence
 * value per cell — the same hand-built-fixture pattern
 * `corridorBendDetectionRibbonMass.test.ts` uses for `RibbonMassSegmentationForBends`,
 * one field richer (a graded `evidence` array instead of just a binary
 * open/closed mask) since that grading is this module's whole point. No
 * LANCZOS/box-mean/opening pipeline runs here, so these tests stay fast and
 * deterministic.
 */
function paintedSegmentation(
	widthEv: number,
	heightEv: number,
	scale: number,
	isOpen: (x: number, y: number) => boolean,
	evidenceAt: (x: number, y: number) => number
): RibbonMassSegmentationForEvidence {
	const binary = new Uint8Array(widthEv * heightEv);
	const evidence = new Float32Array(widthEv * heightEv);
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			const open = isOpen(x, y);
			binary[y * widthEv + x] = open ? 1 : 0;
			evidence[y * widthEv + x] = evidenceAt(x, y);
		}
	}
	const labels = labelComponents(binary, widthEv, heightEv);
	return { widthEv, heightEv, scale, labels, evidence, textureKeptLabels: new Set<number>() };
}

/** Reads `grid.evidence` at a SOURCE-image point via the grid's own origin/scale — mirrors how a real consumer (or the validation script) would map back into the grid, rather than hand-deriving local indices. */
function evidenceAtSrcPoint(
	grid: { widthPx: number; heightPx: number; originXPx: number; originYPx: number; scale: number; evidence: Float32Array },
	xPx: number,
	yPx: number
): number {
	const lx = Math.round((xPx - grid.originXPx) / grid.scale);
	const ly = Math.round((yPx - grid.originYPx) / grid.scale);
	expect(lx).toBeGreaterThanOrEqual(0);
	expect(lx).toBeLessThan(grid.widthPx);
	expect(ly).toBeGreaterThanOrEqual(0);
	expect(ly).toBeLessThan(grid.heightPx);
	return grid.evidence[ly * grid.widthPx + lx];
}

describe('buildModernCorridorEvidence', () => {
	it('matches the CorridorEvidenceGrid field shape exactly', () => {
		const segmentation = paintedSegmentation(
			200,
			200,
			1,
			(x, y) => y >= 95 && y <= 105 && x >= 10 && x <= 190,
			() => 0.8
		);
		const grid = buildModernCorridorEvidence(segmentation, { xPx: 20, yPx: 100 }, { xPx: 180, yPx: 100 }, undefined);
		expect(grid).not.toBeNull();
		expect(Object.keys(grid!).sort()).toEqual(
			['widthPx', 'heightPx', 'originXPx', 'originYPx', 'scale', 'evidence'].sort()
		);
		expect(grid!.evidence).toBeInstanceOf(Float32Array);
		expect(grid!.evidence.length).toBe(grid!.widthPx * grid!.heightPx);
	});

	it('returns null for a degenerate crop window', () => {
		const segmentation = paintedSegmentation(10, 10, 1, () => true, () => 1);
		const grid = buildModernCorridorEvidence(
			segmentation,
			{ xPx: 5, yPx: 5 },
			{ xPx: 5, yPx: 5 },
			undefined,
			[],
			{ ...DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS, marginFraction: 0, minMarginPx: 0, maxMarginPx: 0 }
		);
		expect(grid).toBeNull();
	});

	describe('clean single-component straight hole', () => {
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 180, yPx: 100 };
		function straightSegmentation(): RibbonMassSegmentationForEvidence {
			return paintedSegmentation(
				200,
				200,
				1,
				(x, y) => y >= 95 && y <= 105 && x >= 10 && x <= 190,
				(x, y) => (y >= 95 && y <= 105 && x >= 10 && x <= 190 ? 0.8 : 0)
			);
		}

		it('carries the corridor evidence through and reads 0 off the corridor', () => {
			const grid = buildModernCorridorEvidence(straightSegmentation(), tee, basket, undefined);
			expect(grid).not.toBeNull();
			expect(evidenceAtSrcPoint(grid!, 100, 100)).toBeCloseTo(0.8, 5);
			expect(evidenceAtSrcPoint(grid!, 100, 130)).toBe(0); // off the painted corridor entirely
		});

		it('suppresses a same-tone, un-seeded neighbor blob inside the crop window', () => {
			const segmentation = paintedSegmentation(
				200,
				200,
				1,
				(x, y) => (y >= 95 && y <= 105 && x >= 10 && x <= 190) || (x >= 20 && x <= 30 && y >= 140 && y <= 150),
				(x, y) =>
					(y >= 95 && y <= 105 && x >= 10 && x <= 190) || (x >= 20 && x <= 30 && y >= 140 && y <= 150) ? 0.8 : 0
			);
			const grid = buildModernCorridorEvidence(segmentation, tee, basket, undefined);
			expect(grid).not.toBeNull();
			// The neighbor blob sits inside the crop window (margin covers y up to ~164)
			// but is never seed-touched or texture-admitted, so isolation zeroes it.
			expect(evidenceAtSrcPoint(grid!, 25, 145)).toBe(0);
			// The hole's own corridor is unaffected by the neighbor's presence.
			expect(evidenceAtSrcPoint(grid!, 100, 100)).toBeCloseTo(0.8, 5);
		});
	});

	describe('C1/C2-ring-like circular evidence near the basket', () => {
		// A straight corridor stripe fused, at one crossing point, to a full
		// circular annulus (radius 30) centered on the basket — modeling a
		// hole's own C1/C2 ring reading at the SAME evidence tone as its true
		// ribbon and touching it, so both land in one seed-connected kept
		// component (ring-arc-spike.ts's finding: ownership alone does not
		// exempt a ring, so isolation-by-component-membership cannot be the
		// whole story — ring-band damping has to do the rest).
		const basket: SourcePoint = { xPx: 170, yPx: 100 };
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		function ringFusedSegmentation(): RibbonMassSegmentationForEvidence {
			const isCorridor = (x: number, y: number) => y >= 95 && y <= 105 && x >= 10 && x <= 190;
			const isRing = (x: number, y: number) => {
				const d = Math.hypot(x - basket.xPx, y - basket.yPx);
				return d >= 27 && d <= 33;
			};
			const isOpen = (x: number, y: number) => isCorridor(x, y) || isRing(x, y);
			return paintedSegmentation(220, 200, 1, isOpen, (x, y) => (isOpen(x, y) ? 0.8 : 0));
		}

		it('keeps far-corridor evidence undamped but damps evidence on the discovered ring band', () => {
			const grid = buildModernCorridorEvidence(ringFusedSegmentation(), tee, basket, undefined, [30]);
			expect(grid).not.toBeNull();
			// Far from the ring band (distance ~120px from the basket): untouched.
			expect(evidenceAtSrcPoint(grid!, 50, 100)).toBeCloseTo(0.8, 5);
			// On the ring band (distance exactly 30px from the basket, off the
			// corridor stripe entirely — pure ring evidence): damped down.
			const onRing = evidenceAtSrcPoint(grid!, 170, 70);
			expect(onRing).toBeCloseTo(0.8 * DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS.ringDampingFactor, 5);
			expect(onRing).toBeLessThan(0.8);
		});

		it('does not damp anything when no ring radii are supplied', () => {
			const grid = buildModernCorridorEvidence(ringFusedSegmentation(), tee, basket, undefined, []);
			expect(grid).not.toBeNull();
			expect(evidenceAtSrcPoint(grid!, 170, 70)).toBeCloseTo(0.8, 5);
		});
	});

	describe('small occluder-gap bridging', () => {
		// Two disconnected components (a 6px non-evidence gap between them,
		// stroke scale — the occluder-bridge-spike.ts v2 hypothesis) sitting
		// ~36-37px from the basket.
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 170, yPx: 100 };
		function gappedSegmentation(): RibbonMassSegmentationForEvidence {
			const isSideA = (x: number, y: number) => y >= 95 && y <= 105 && x >= 10 && x <= 130;
			const isSideB = (x: number, y: number) => y >= 95 && y <= 105 && x >= 137 && x <= 190;
			const isOpen = (x: number, y: number) => isSideA(x, y) || isSideB(x, y);
			return paintedSegmentation(200, 200, 1, isOpen, (x, y) => (isOpen(x, y) ? 0.8 : 0));
		}

		it('bridges the gap to at least bridgeEvidenceFloor when the gap sits inside the discovered ring band', () => {
			// Gap center (133.5, 100) is ~36.5px from the basket (170, 100).
			const grid = buildModernCorridorEvidence(gappedSegmentation(), tee, basket, undefined, [36]);
			expect(grid).not.toBeNull();
			expect(evidenceAtSrcPoint(grid!, 133, 100)).toBeGreaterThanOrEqual(
				DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS.bridgeEvidenceFloor
			);
		});

		it('leaves the gap at 0 when no ring radii are supplied (bridging never runs on open terrain)', () => {
			const grid = buildModernCorridorEvidence(gappedSegmentation(), tee, basket, undefined, []);
			expect(grid).not.toBeNull();
			expect(evidenceAtSrcPoint(grid!, 133, 100)).toBe(0);
		});

		it('leaves the gap at 0 when the gap sits outside every discovered ring band', () => {
			// A radius far from the actual ~36.5px gap distance never opens a band there.
			const grid = buildModernCorridorEvidence(gappedSegmentation(), tee, basket, undefined, [120]);
			expect(grid).not.toBeNull();
			expect(evidenceAtSrcPoint(grid!, 133, 100)).toBe(0);
		});
	});
});
