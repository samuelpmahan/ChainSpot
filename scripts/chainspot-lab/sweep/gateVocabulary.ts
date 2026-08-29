// One vocabulary, shared with the algorithm. Gate order is semantic and
// monotonic; `shared` describes infrastructure ownership and is not another
// scheduled phase.
//
// -------------------------------------------------------------------------
// THE --through CUTOFF DESIGN (this is where the invariant lives)
//
// The compiled plan is chronological and deliberately interleaves gates: the
// frozen default plan runs assignment.selection (G6) before teeRecovery (G4)
// before zfit (G7), because recovery consumes the first assignment pass.
// Filtering operations by gate index therefore breaks consumes/produces
// dependencies, and any non-contiguous subset can also silently change
// behavior, because several operations REWRITE slots in place
// (badgeOcclusionPatch rewrites supportField, teeFamily rewrites tees,
// teeRecovery rewrites assignment): skipping an intermediate rewriter hands a
// later operation different bytes than the full run.
//
// So a cutoff is a CONTIGUOUS CHRONOLOGICAL PREFIX of the frozen plan — the
// shortest prefix that contains every scheduled operation semantically owned
// by a gate at or below the cutoff (ownership per GATE_OPERATION_OWNERSHIP,
// not the operation's declared engine gate label, which is a documented stale
// alias for several operations). A prefix of a dependency-validated order is
// dependency-complete by construction, and every operation in it sees board
// state byte-identical to the full run. Later-gate operations that fall
// inside the prefix are scheduled PREREQUISITES and the receipt names, per
// operation, the produced slot and the downstream consumer that required it;
// operations after the prefix are NOT SCHEDULED and the receipt says so.
//
// The owner's phase model maps onto cutoffs like this:
//   G1 Badges, G2 Baskets, G3 Visible Tees — unchanged prefixes.
//   G4 Recovery (Tee + Basket) — endpoints-complete: the prefix ends at the
//      last scheduled recovery operation (teeRecovery / phantomTee), pulling
//      in the straight-evidence and first-assignment operations it consumes.
//   G5 Straight Test — two parts: straight evidence (part 1) and assignment/
//      completion of straight holes (part 2, delivered by the G6-owned
//      assignment operations, which this cutoff therefore schedules).
//   G6 Bent pathfinding + refinement — the phase folds the terminal Z-fit
//      slot in, so its prefix runs the complete plan.
//   G7 Terminal Z-fit slot — kept as an explicit alias of the end of G6's
//      phase; same prefix as G6 for any config that schedules zfit.
// A cutoff whose own phase owns zero scheduled operations is rejected with a
// plain-language error naming the operations that would demonstrate it.

import {
	CANONICAL_GATE_ORDER,
	GATE_TITLES,
	type GateId
} from '@chainspot/alg/detectors/threeFactor/features/types';
import {
	GATE_OPERATION_OWNERSHIP,
	type GateFeatureSetId
} from '@chainspot/alg/detectors/threeFactor/gate-sets';

export type EngineGateId = Exclude<GateId, 'shared'>;

export const GATE_ORDER: readonly EngineGateId[] = CANONICAL_GATE_ORDER;

/** Every canonical gate is now a dependency-complete cutoff (contiguous
 * chronological prefix — see the design note above). */
export const SWEEP_THROUGH_GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const;
export type SweepThroughGate = (typeof SWEEP_THROUGH_GATES)[number];

const SET_GATE: Record<Exclude<GateFeatureSetId, 'shared-set'>, EngineGateId> = {
	'g1-set': 'G1',
	'g2-set': 'G2',
	'g3-set': 'G3',
	'g4-set': 'G4',
	'g5-set': 'G5',
	'g6-set': 'G6',
	'g7-set': 'G7'
};

/** Semantic owning gate of an operation id, from the one ownership table. */
export function operationOwnerGate(operationId: string): EngineGateId | 'shared' {
	const setId = GATE_OPERATION_OWNERSHIP[operationId];
	if (!setId || setId === 'shared-set') return 'shared';
	return SET_GATE[setId];
}

export function gateRank(gate: EngineGateId): number {
	return GATE_ORDER.indexOf(gate);
}

export interface ThroughCutoffContract {
	/** One-line phase contract, printed by receipts and errors. */
	readonly phase: string;
	/** Gates whose owned operations this cutoff must run (cumulative closure
	 * happens in the slicer; this names the cutoff's OWN phase). */
	readonly ownGates: readonly EngineGateId[];
	/** Operation ids that demonstrate the phase; at least one must be
	 * scheduled or the cutoff is rejected. */
	readonly demonstratedBy: readonly string[];
}

/** The owner's rearranged phase model, expressed as cutoff contracts.
 * `demonstratedBy` lists the semantically-owned operations of the cutoff's
 * own phase; the slicer rejects a cutoff none of whose operations are
 * scheduled, naming them. */
export const THROUGH_CUTOFF_CONTRACTS: Record<SweepThroughGate, ThroughCutoffContract> = {
	G1: {
		phase: 'Badges known',
		ownGates: ['G1'],
		demonstratedBy: [
			'badgeStage.masks',
			'badgeStage.components',
			'badgeStage.family',
			'badgeStage.badges',
			'badges',
			'badgeGlyphTemplate'
		]
	},
	G2: {
		phase: 'Baskets known',
		ownGates: ['G2'],
		demonstratedBy: ['baskets', 'cleanBasketFamily']
	},
	G3: {
		phase: 'Visible tees known',
		ownGates: ['G3'],
		demonstratedBy: ['tees.ringMeasure', 'tees.exclusion', 'teeFamily', 'teeMinAreaPose']
	},
	G4: {
		phase: 'Recovery (Tee + Basket): all endpoints the run will ever have are on the board',
		ownGates: ['G4'],
		demonstratedBy: ['teeRecovery', 'phantomTee', 'teeBadgeLock', 'teeBadgeCompass']
	},
	G5: {
		phase:
			'Straight Test part 1 (straight evidence) + part 2 (straight-hole assignment); endpoint completion (G4) is included cumulatively',
		ownGates: ['G5', 'G6'],
		demonstratedBy: [
			'straightTest',
			'supportField',
			'badgeOcclusionPatch',
			'rawPairs',
			'measurement',
			'assignment.pairs',
			'assignment.scoring',
			'assignment.ranking',
			'assignment.selection'
		]
	},
	G6: {
		phase: 'Bent pathfinding + refinement: remaining holes with one or more bends, terminal Z-fit folded in',
		ownGates: ['G6', 'G7'],
		demonstratedBy: ['assignment.pairs', 'assignment.scoring', 'assignment.ranking', 'assignment.selection', 'zfit']
	},
	G7: {
		phase: 'Terminal Z-fit slot (alias of the end of the G6 phase)',
		ownGates: ['G7'],
		demonstratedBy: ['zfit']
	}
};

// The contract table must stay consistent with semantic ownership: every
// operation it names must be owned by one of the cutoff's own gates (G5/G6
// deliberately reach forward per the owner's phase model, so the check is
// against ownGates, not the cutoff id).
for (const [cutoff, contract] of Object.entries(THROUGH_CUTOFF_CONTRACTS)) {
	for (const operationId of contract.demonstratedBy) {
		const owner = operationOwnerGate(operationId);
		if (owner === 'shared' || !contract.ownGates.includes(owner)) {
			throw new Error(
				`gateVocabulary: cutoff ${cutoff} names operation '${operationId}' owned by '${owner}', outside its own gates [${contract.ownGates.join(', ')}].`
			);
		}
	}
}
// ...and every owned, schedulable operation of a cutoff's own gates must be
// named, so a newly registered operation cannot silently escape its phase.
{
	const gateOps = new Map<EngineGateId, string[]>();
	for (const [operationId, setId] of Object.entries(GATE_OPERATION_OWNERSHIP)) {
		if (setId === 'shared-set') continue;
		const gate = SET_GATE[setId as Exclude<GateFeatureSetId, 'shared-set'>];
		gateOps.set(gate, [...(gateOps.get(gate) ?? []), operationId]);
	}
	for (const [cutoff, contract] of Object.entries(THROUGH_CUTOFF_CONTRACTS)) {
		const expected = contract.ownGates.flatMap((gate) => gateOps.get(gate) ?? []);
		for (const operationId of expected) {
			if (!contract.demonstratedBy.includes(operationId)) {
				throw new Error(
					`gateVocabulary: cutoff ${cutoff} is missing owned operation '${operationId}' from demonstratedBy.`
				);
			}
		}
	}
}

export function gateLabel(gate: string): string {
	if (gate === 'shared') return 'Shared Infrastructure';
	return isKnownGate(gate) ? `${gate} ${GATE_TITLES[gate]}` : gate;
}

export function isKnownGate(gate: string): gate is EngineGateId {
	return (GATE_ORDER as readonly string[]).includes(gate);
}

export function isSweepThroughGate(gate: string): gate is SweepThroughGate {
	return (SWEEP_THROUGH_GATES as readonly string[]).includes(gate);
}
