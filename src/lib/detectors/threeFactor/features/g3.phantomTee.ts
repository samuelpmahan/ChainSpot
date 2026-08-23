// Predecessor-basket phantom tee — the first NEW isolated ABFeature file.
// Ported from the LAB's C01 Complete Occlusion fallback
// (origin/codex/seatac-phantom-tee: src/lib/nuthing/phantomTee.ts), adapted
// to threeFactor semantics: ownership is assignment OUTPUT here, so this is
// a second-pass unit — after assignment, a hole whose badge found no viable
// tee gets one synthesized at its predecessor hole's assigned basket tip,
// and assignment re-runs with the recovered inputs. Phantom evidence keeps
// explicit provenance and must never feed an appearance model (appearance
// is UNKNOWN by construction). Default OFF.

import { assignThreeFactor, type ZfitKnobs } from '../assignment';
import type {
	AssignmentEvidence,
	BasketEvidence,
	RecoveredTeeInput,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../types';
import type { ABFeature, EngineUnit } from './types';
import { zfitFeature } from './g5.zfit';

export const phantomTeeFeature = {
	id: 'phantomTee',
	gate: 'G3',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'C01 complete-occlusion fallback: synthesize a missing tee at the predecessor hole\'s assigned basket tip.',
	knobs: {
		minViableScore: {
			default: 0,
			note: 'a hole whose best assignment score is at or below this counts as tee-less',
			validate: (value: unknown) => (typeof value === 'number' ? null : 'minViableScore must be a number')
		}
	}
} satisfies ABFeature;

/** Pure core, exported for tests: which phantom tees would be synthesized. */
export function synthesizePhantomTees(
	measurement: ThreeFactorMeasurement,
	assignments: readonly AssignmentEvidence[],
	minViableScore: number
): RecoveredTeeInput[] {
	const badgeById = new Map(measurement.badges.map((badge) => [badge.detId, badge]));
	const basketById = new Map(measurement.baskets.map((basket) => [basket.detId, basket]));
	const assignmentByHole = new Map<number, AssignmentEvidence>();
	for (const assignment of assignments) {
		const label = badgeById.get(assignment.badgeId)?.label;
		const hole = label === null || label === undefined ? NaN : Number(label);
		if (Number.isInteger(hole)) assignmentByHole.set(hole, assignment);
	}
	const holes = [...assignmentByHole.keys()].sort((a, b) => a - b);
	const missing = new Set<number>();
	for (const badge of measurement.badges) {
		const hole = badge.label === null ? NaN : Number(badge.label);
		if (!Number.isInteger(hole)) continue;
		const assignment = assignmentByHole.get(hole);
		if (!assignment || assignment.score <= minViableScore) missing.add(hole);
	}

	const phantoms: RecoveredTeeInput[] = [];
	for (const hole of [...missing].sort((a, b) => a - b)) {
		if (hole <= 1) continue; // T1 has no predecessor; stays unresolved
		const predecessor = assignmentByHole.get(hole - 1);
		if (!predecessor || missing.has(hole - 1)) continue;
		const basket: BasketEvidence | undefined = basketById.get(predecessor.basketId);
		if (!basket) continue;
		phantoms.push({
			xPx: basket.tipXPx,
			yPx: basket.tipYPx,
			provenance: {
				source: 'explicit-injected',
				note: `phantom-predecessor-basket hole ${hole} from B${hole - 1} tip`,
				score: 0.5
			}
		});
	}
	void holes;
	return phantoms;
}

export const phantomTeeUnit: EngineUnit = {
	id: 'phantomTee',
	gate: 'G3',
	consumes: ['measurement', 'assignment', 'recoveredTees'],
	produces: ['recoveredTees', 'assignment'],
	note: 'synthesize predecessor-basket phantom tees for tee-less holes, then re-assign',
	run(board, ctx) {
		const stop = ctx.span('phantomTee');
		const state = ctx.resolve(phantomTeeFeature);
		if (state.enabled) {
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const assignment = board.get<ThreeFactorAssignment>('assignment');
			const existing = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
			const phantoms = synthesizePhantomTees(
				measurement,
				assignment.assignments,
				state.knobs['minViableScore'] as number
			);
			for (const phantom of phantoms) {
				ctx.overlay('phantomTee', {
					type: 'point',
					xPx: phantom.xPx,
					yPx: phantom.yPx,
					verdict: 'accepted',
					reason: phantom.provenance.note
				});
			}
			ctx.measure('phantomTee', 'synthesized', phantoms.length);
			if (phantoms.length > 0) {
				const merged = [...existing, ...phantoms];
				const zfit = ctx.resolve(zfitFeature);
				board.set('recoveredTees', merged);
				board.set(
					'assignment',
					assignThreeFactor(measurement, merged, zfit.knobs as unknown as ZfitKnobs)
				);
			}
		}
		stop();
	}
};
