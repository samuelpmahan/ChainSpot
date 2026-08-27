import { describe, expect, test } from 'vitest';
import { parseConfig } from '@chainspot/alg/detectors/threeFactor';
import {
	evaluateStraightTestCandidate,
	measureStraightGeometry,
	straightTestUnit
} from '@chainspot/alg/detectors/threeFactor/features/st.straightTest';
import type { StraightTestCandidateInput } from '@chainspot/alg/detectors/threeFactor/features/st.straightTest.contract';

const base: StraightTestCandidateInput = {
	holeLabel: '1',
	badge: { detId: 'b', xPx: 0, yPx: 0, label: '1', provenance: 'detector' },
	tee: { detId: 't', xPx: 0, yPx: 0, tier: 'ring', angleRad: 0, provenance: 'detector' },
	basket: { detId: 'k', xPx: 10, yPx: 0, strongIdentity: true, provenance: 'detector' }
};
const blind = { mode: 'blind' as const, locks: [] };

describe('straight-test boundary behavior', () => {
	test('rejects non-boolean truthAssisted', () => {
		expect(() =>
			parseConfig({
				schema: 'threeFactor-config@1',
				name: 'x',
				gates: { G5: { straightTest: { knobs: { truthAssisted: 'yes' } } } }
			})
		).toThrow(/truthAssisted/);
	});
	test('invalid tee angle is UNKNOWN without poisoning valid chord geometry', () => {
		const measured = measureStraightGeometry({
			...base,
			badge: { ...base.badge, xPx: 3, yPx: 4 },
			tee: { ...base.tee!, angleRad: Number.NaN }
		});
		expect(measured.axialResidualDeg).toBeNull();
		expect(measured.directionalResidualDeg).toBeCloseTo(53.1301023542, 9);
		const proposal = evaluateStraightTestCandidate(
			{
				...base,
				badge: { ...base.badge, xPx: 3, yPx: 4 },
				tee: { ...base.tee!, angleRad: Number.NaN }
			},
			blind
		);
		expect(proposal.geometryEndpoints?.tee.axisAngleRad).toBeNull();
	});
	test('badge coincident with tee leaves angle residuals UNKNOWN', () => {
		const measured = measureStraightGeometry(base);
		expect(measured.axialResidualDeg).toBeNull();
		expect(measured.directionalResidualDeg).toBeNull();
		expect(measured.collinearityResidualDeg).toBeNull();
	});
	test('verified assistance refuses when truthAssisted knob is false', () => {
		const board = {
			get: (slot: string) =>
				slot === 'straightTestTruthAssistance'
					? { mode: 'verified-canonical', taint: 'TRUTH-TAINT', locks: [] }
					: undefined,
			has: () => true,
			set: () => {}
		} as never;
		const ctx = {
			resolve: () => ({ enabled: true, knobs: { truthAssisted: false } }),
			measure: () => {},
			overlay: () => {},
			heatmap: () => {},
			span: () => () => {},
			occlusion: {}
		} as never;
		expect(() => straightTestUnit.run(board, ctx)).toThrow(/truthAssisted=true/);
	});
	test('disabled scheduled unit emits no S0 testimony', () => {
		const slots = new Map<string, unknown>();
		const board = {
			get: (slot: string) => slots.get(slot),
			has: (slot: string) => slots.has(slot),
			set: (slot: string, value: unknown) => slots.set(slot, value)
		} as never;
		let recorded = false;
		const ctx = {
			resolve: () => ({ enabled: false, knobs: { truthAssisted: false } }),
			recordStraightTest: () => {
				recorded = true;
			}
		} as never;
		straightTestUnit.run(board, ctx);
		expect(slots.get('straightProposals')).toEqual([]);
		expect(recorded).toBe(false);
	});
});
