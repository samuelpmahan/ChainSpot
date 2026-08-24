// The engine's own gate vocabulary, exactly as declared by
// packages/alg/src/detectors/threeFactor/features/types.ts's GateId type
// (checked against that file directly, not guessed): 'G1' | 'G2' | 'G3' |
// 'G4' | 'ST' | 'G5' | 'shared'. GATE_ORDER below matches that file's own
// declared union order, which is also the order the owner's sprint spec
// lists them in ("G1 Badges, G2 Baskets, G3 Tees, G4 Tee->Badge, ST, G5
// Path"). LAB groups/labels by this vocabulary; it does not invent one.

export type EngineGateId = 'G1' | 'G2' | 'G3' | 'G4' | 'ST' | 'G5' | 'shared';

export const GATE_ORDER: readonly EngineGateId[] = ['G1', 'G2', 'G3', 'G4', 'ST', 'G5', 'shared'];

/** Display labels. G1-G5 + 'ST' text taken from the owner's brief; 'shared'
 * covers cross-gate infra (shared.hsv's masks, the final measurement
 * materialize op) that isn't scoped to one gate. */
export const GATE_LABELS: Readonly<Record<EngineGateId, string>> = {
	G1: 'G1 Badges',
	G2: 'G2 Baskets',
	G3: 'G3 Tees',
	G4: 'G4 Tee→Badge',
	ST: 'ST Straight Test',
	G5: 'G5 Path',
	shared: 'Shared (cross-gate)'
};

export function gateLabel(gate: string): string {
	return GATE_LABELS[gate as EngineGateId] ?? gate;
}

export function isKnownGate(gate: string): gate is EngineGateId {
	return (GATE_ORDER as readonly string[]).includes(gate);
}
