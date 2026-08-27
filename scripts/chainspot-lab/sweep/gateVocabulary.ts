// One vocabulary, shared with the algorithm. Gate order is semantic and
// monotonic; `shared` describes infrastructure ownership and is not another
// scheduled phase.

import {
	CANONICAL_GATE_ORDER,
	GATE_TITLES,
	type GateId
} from '@chainspot/alg/detectors/threeFactor/features/types';

export type EngineGateId = Exclude<GateId, 'shared'>;

export const GATE_ORDER: readonly EngineGateId[] = CANONICAL_GATE_ORDER;

/** Cutoffs already dependency-complete for every current config. */
export const SWEEP_THROUGH_GATES = ['G1', 'G2', 'G3'] as const;
export type SweepThroughGate = (typeof SWEEP_THROUGH_GATES)[number];

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
