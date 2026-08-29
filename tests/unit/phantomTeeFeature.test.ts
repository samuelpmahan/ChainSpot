import { describe, expect, test } from 'vitest';
import { phantomTeeUnit, synthesizePhantomTees } from '@chainspot/alg/detectors/threeFactor/features/g3.phantomTee';
import { parseConfig } from '@chainspot/alg/detectors/threeFactor';
import phantomOnJson from '@chainspot/alg/detectors/threeFactor/configs/phantom-tee-on.json';
import type {
	AssignmentEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor';
import { createBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { defaultKnobs, type FeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { OcclusionDetector } from '@chainspot/alg/detectors/threeFactor/occlusion';

function badge(detId: string, label: string, cx: number, cy: number) {
	return {
		detId,
		component: { label: 1, area: 10, cx, cy, bboxX: cx - 5, bboxY: cy - 5, bboxW: 10, bboxH: 10, major: 5, minor: 4, angle: 0, axisMajorMin: -2, axisMajorMax: 2, axisMinorMin: -1.5, axisMinorMax: 1.5, fill: 0.8 },
		cxPx: cx,
		cyPx: cy,
		bbox: [cx - 5, cy - 5, 10, 10] as const,
		source: 'bright-family' as const,
		digits: [],
		rawLabel: label,
		digitCount: label.length,
		label,
		bestLabel: label,
		labelCandidates: [{ label: Number(label), confidence: 0.9 }],
		confidence: 0.9,
		abstentionReason: null,
		confidenceFloor: 0.1,
		conflictWith: [],
		notes: []
	};
}

function basket(detId: string, tipX: number, tipY: number) {
	return {
		detId,
		bbox: [tipX - 3, tipY - 8, 6, 8] as const,
		whiteBbox: [tipX - 3, tipY - 8, 6, 8] as const,
		centerXPx: tipX,
		centerYPx: tipY - 4,
		tipXPx: tipX,
		tipYPx: tipY,
		onFrac: 0.9,
		offFrac: 0.1,
		score: 0.9
	};
}

function measurementFixture(): ThreeFactorMeasurement {
	return {
		algo: '3factor-dev72',
		algoVersion: '1.0.0',
		widthPx: 200,
		heightPx: 200,
		viewport: { topPx: 0, bottomPx: 200, sourceFrame: 'original-image' },
		parameters: {
			corridorWidthPx: 37,
			fieldScale: 3,
			orientations: 12,
			widthsSrc: [24],
			patchBadges: true,
			alignmentPower: 2,
			worstWindowSrcPx: 90,
			supportTau: 0.5
		},
		brightMask: { width: 200, height: 200, data: new Uint8Array(200 * 200) },
		darkMask: { width: 200, height: 200, data: new Uint8Array(200 * 200) },
		badges: [badge('badge-0', '1', 30, 30), badge('badge-1', '2', 120, 30)],
		baskets: [basket('basket-0', 60, 80), basket('basket-1', 160, 90)],
		tees: [],
		field: {
			width: 67,
			height: 67,
			scale: 3,
			support: new Float32Array(67 * 67).fill(1),
			bestTheta: new Float32Array(67 * 67),
			parameters: { orientations: 12, widthsSrc: [24], gaussianSigma: 0.8, normalizationPercentile: 0.995, gamma: 0.7 }
		},
		rawPairs: []
	};
}

function assignment(badgeId: string, basketId: string, score: number): AssignmentEvidence {
	return {
		badgeId,
		teeId: 'tee-0',
		basketId,
		score,
		rank: 1,
		ownership: 'selected',
		alternatives: []
	};
}

describe('phantomTee (C01 predecessor-basket fallback)', () => {
	test('synthesizes at the predecessor hole basket tip for tee-less holes', () => {
		// hole 1 assigned well; hole 2 has NO assignment -> phantom at B1 tip
		const phantoms = synthesizePhantomTees(
			measurementFixture(),
			[assignment('badge-0', 'basket-0', 0.8)],
			0
		);
		expect(phantoms).toHaveLength(1);
		expect(phantoms[0].xPx).toBe(60);
		expect(phantoms[0].yPx).toBe(80);
		expect(phantoms[0].provenance.note).toContain('hole 2');
		expect(phantoms[0].provenance.note).toContain('B1');
	});

	test('completes hole 1 and chain gaps with deterministic finite fallback locations', () => {
		// Hole 1 has no predecessor; it must still receive a deterministic,
		// finite placement rather than silently remaining unassigned. Hole 2
		// receives the normal predecessor-basket placement even if hole 1 was
		// initially missing.
		const phantoms = synthesizePhantomTees(
			measurementFixture(),
			[assignment('badge-1', 'basket-1', 0.8)],
			0
		);
		expect(phantoms).toHaveLength(1);
		expect(Number.isFinite(phantoms[0].xPx)).toBe(true);
		expect(Number.isFinite(phantoms[0].yPx)).toBe(true);
		expect(phantoms[0].provenance.note).toContain('hole 1');
		expect(phantoms[0].provenance.note).toContain('fallback');
	});

	test('fills all numbered holes deterministically when none received an assignment', () => {
		const fixture = measurementFixture();
		// maxCompletions raised explicitly: this test exercises deterministic
		// multi-hole synthesis; the production default budget is 1 (owner
		// policy: phantom is a scalpel, not a spray).
		const first = synthesizePhantomTees(fixture, [], 0, 18);
		const second = synthesizePhantomTees(fixture, [], 0, 18);
		expect(first).toHaveLength(2);
		expect(first).toEqual(second);
		for (const phantom of first) {
			expect(Number.isFinite(phantom.xPx)).toBe(true);
			expect(Number.isFinite(phantom.yPx)).toBe(true);
			expect(phantom.provenance.note).toMatch(/fallback|B\d+ tip/);
		}
	});

	test('unit completion reruns normal assignment then covers every finite numbered badge', () => {
		const measurement = measurementFixture();
		const board = createBoard();
		board.set('measurement', measurement);
		board.set('recoveredTees', []);
		board.set('assignment', { measurement, tees: [], scoredPairs: [], assignments: [] } satisfies ThreeFactorAssignment);
		const context: FeatureContext = {
			occlusion: new OcclusionDetector(),
			resolve: (feature) =>
				feature.id === 'phantomTee'
					? { enabled: true, knobs: { minViableScore: 0, maxCompletions: 18 } }
					: { enabled: feature.defaultEnabled, knobs: defaultKnobs(feature) },
			measure() {},
			overlay() {},
			heatmap() {},
			span: () => () => {}
		};
		phantomTeeUnit.run(board, context);
		const result = board.get<ThreeFactorAssignment>('assignment');
		expect(result.assignments.map((row) => row.badgeId).sort()).toEqual(['badge-0', 'badge-1']);
		expect(result.assignments.every((row) => row.score >= 0)).toBe(true);
		expect(new Set(result.assignments.map((row) => row.teeId)).size).toBe(result.assignments.length);
		expect(new Set(result.assignments.map((row) => row.basketId)).size).toBe(result.assignments.length);
	});

	test('a hole with a viable assignment gets no phantom', () => {
		const phantoms = synthesizePhantomTees(
			measurementFixture(),
			[assignment('badge-0', 'basket-0', 0.8), assignment('badge-1', 'basket-1', 0.7)],
			0
		);
		expect(phantoms).toHaveLength(0);
	});

	test('phantom-tee-on config parses and lists the unit in execution', () => {
		const config = parseConfig(phantomOnJson);
		expect(config.execution).toContain('phantomTee');
		expect(config.gates?.G4?.phantomTee?.enabled).toBe(true);
	});

	test('empty whitelist produces identical behavior to no whitelist', () => {
		const measurement = measurementFixture();
		const assignments = [assignment('badge-0', 'basket-0', 0.8)];
		const withoutWhitelist = synthesizePhantomTees(measurement, assignments, 0, 1);
		const withEmptyWhitelist = synthesizePhantomTees(measurement, assignments, 0, 1, []);
		expect(withoutWhitelist).toEqual(withEmptyWhitelist);
	});

	test('whitelisted hole gets phantom injection with whitelist note in provenance', () => {
		const measurement = measurementFixture();
		// Hole 2 is missing, hole 1 is assigned. Without whitelist, hole 2 gets normal predecessor phantom.
		// With AC12 whitelist for hole 12, that's outside our fixture so no effect on hole 2.
		// Create a fixture where hole 12 is missing but has a badge.
		const extendedMeasurement = {
			...measurement,
			badges: [
				...measurement.badges,
				badge('badge-12', '12', 150, 150)
			]
		};
		const whitelist = [{ hole: '12', note: 'AC12: tee genuinely invisible — owner-declared' }];
		const phantoms = synthesizePhantomTees(
			extendedMeasurement,
			[assignment('badge-0', 'basket-0', 0.8)],
			0,
			18, // Raise budget to allow multiple phantoms
			whitelist
		);
		// Should get phantoms for holes 2 and 12. Hole 12 should be prioritized and carry the whitelist note.
		const hole12Phantom = phantoms.find((p) => p.provenance.note.includes('hole 12'));
		expect(hole12Phantom).toBeDefined();
		expect(hole12Phantom?.provenance.note).toContain('AC12: tee genuinely invisible');
	});

	test('whitelisted hole is prioritized within budget over non-whitelisted holes', () => {
		const measurement = {
			...measurementFixture(),
			badges: [
				badge('badge-0', '1', 30, 30),
				badge('badge-1', '2', 120, 30),
				badge('badge-12', '12', 150, 150),
				badge('badge-13', '13', 160, 160)
			]
		};
		// All holes 2, 12, 13 are missing. With budget of 1 and whitelist for hole 12,
		// hole 12 should be allocated before holes 2 and 13.
		const whitelist = [{ hole: '12', note: 'whitelisted hole' }];
		const phantoms = synthesizePhantomTees(
			measurement,
			[assignment('badge-0', 'basket-0', 0.8)],
			0,
			1, // Budget of 1
			whitelist
		);
		expect(phantoms).toHaveLength(1);
		expect(phantoms[0].provenance.note).toContain('hole 12');
		expect(phantoms[0].provenance.note).toContain('whitelisted hole');
	});

	test('non-whitelisted hole gets no phantom when whitelisted hole exhausts budget', () => {
		const measurement = {
			...measurementFixture(),
			badges: [
				badge('badge-0', '1', 30, 30),
				badge('badge-2', '2', 120, 30),
				badge('badge-12', '12', 150, 150)
			]
		};
		const whitelist = [{ hole: '12', note: 'whitelisted' }];
		const synthesis = synthesizePhantomTees(
			measurement,
			[assignment('badge-0', 'basket-0', 0.8)],
			0,
			1, // Budget of 1 — only hole 12 (whitelisted) should get phantom
			whitelist
		);
		expect(synthesis).toHaveLength(1);
		expect(synthesis[0].provenance.note).toContain('hole 12');
	});

	test('whitelisted hole that IS served gets no phantom (whitelist authorizes, never forces duplicate)', () => {
		const measurement = measurementFixture();
		const whitelist = [{ hole: '1', note: 'whitelisted but served' }];
		// Hole 1 has a good assignment
		const phantoms = synthesizePhantomTees(
			measurement,
			[assignment('badge-0', 'basket-0', 0.8)],
			0,
			1,
			whitelist
		);
		// Should only get phantom for unserved hole 2, not duplicate for hole 1
		expect(phantoms).toHaveLength(1);
		expect(phantoms[0].provenance.note).toContain('hole 2');
	});
});
