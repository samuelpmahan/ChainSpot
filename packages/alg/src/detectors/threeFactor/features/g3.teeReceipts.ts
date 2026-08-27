// Trace-only receipts for tee recovery and assignment-only phantom tees.
//
// These plans deliberately do not inspect pixels or rebuild geometry. The
// detector owns the coordinates and corners; this module only selects the
// already-emitted drawables by their semantic refs. That keeps the trace,
// CLI receipt, and rendered overlay one-to-one.

import type { FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

function byVerdict(unit: UnitTrace, verdict: 'accepted' | 'rejected' | 'info') {
	return unit.drawables.filter((drawable) => drawable.verdict === verdict);
}

function isCorner(drawable: { readonly type: string; readonly visualRole?: string }): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'tee-corner-tick';
}

function isPhantom(drawable: { readonly visualRole?: string }): boolean {
	return drawable.visualRole === 'phantom-center';
}

function runNotes(featureId: string, unit: UnitTrace, run: RunTrace): string[] {
	const state = run.features[featureId];
	const stateLine = state
		? `feature state: enabled=${state.enabled} knobs=${JSON.stringify(state.knobs)} (source: RunTrace.features['${featureId}'])`
		: `feature state: UNKNOWN -- RunTrace.features['${featureId}'] is absent`;
	return [
		`feature: ${featureId} -- ${unit.gate}, trace unit '${unit.id}'`,
		`unit enabled: ${unit.enabled} (source: UnitTrace.enabled)`,
		`config: ${run.configName}`,
		`paramsHash: ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
		`unit ms: ${unit.ms.toFixed(2)} (source: UnitTrace.ms; wall clock, not a quality signal)`,
		stateLine
	];
}

/** Visual contract for the experimental visible-shard recovery feature. */
export const TEE_RECOVERY_RENDER: FeatureRender = {
	units: ['teeRecovery'],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = byVerdict(unit, 'accepted');
		const rejected = byVerdict(unit, 'rejected');
		const info = byVerdict(unit, 'info');
		const corners = info.filter(isCorner);
		const otherInfo = info.filter((drawable) => !isCorner(drawable));
		const shard = accepted.filter((drawable) => drawable.visualRole === 'tee-shard');
		return {
			title: `G4 teeRecovery -- post-assignment shard recovery (${run.configName})`,
			base: 'badgeStage.masks.bright',
			layers: [
				{
					name: 'visible shard highlighted (G4 post-assignment recovery)',
					note: 'exact owned-white-pixel BFS remainder/extension emitted by teeRecovery; this layer does not imply the shard is hidden',
					drawables: shard
				},
				{
					name: 'calculated or assumed four corners (G4 post-assignment recovery)',
					note: 'four corner indicators emitted by the detector from its fitted or assumed outline',
					drawables: corners
				},
				{
					name: 'tee recovery candidates rejected (G4)',
					note: 'every rejected candidate remains visible with its detector-supplied reason',
					drawables: rejected
				},
				...(otherInfo.length
					? [
							{
								name: 'tee recovery trace information (G4)',
								note: 'informational evidence retained from the trace',
								drawables: otherInfo
							}
						]
					: [])
			],
			notes: [
				...runNotes('teeRecovery', unit, run),
				`accepted drawables: ${accepted.length} (source: UnitTrace.drawables verdict='accepted')`,
				`visible shard drawables: ${shard.length} (source: accepted trace drawables with visualRole='tee-shard')`,
				`corner drawables: ${corners.length} (source: info trace drawables with visualRole='tee-corner-tick'; expected four when recovery completes)`,
				`rejected candidates: ${rejected.length} (source: UnitTrace.drawables verdict='rejected')`,
				'phase: G4 post-assignment recovery; normal assignment evidence is consumed before this unit and rerun after accepted shards.',
				'C1S=solid 10m; C2D=dashed 20m. Traversed local-component fields: UNKNOWN -- none were emitted in this trace.',
				'appearance: UNKNOWN -- a recovered shard is an unowned white-pixel remainder/extension, not an appearance-model claim.',
				'recovery display is trace-driven: no pixels, fit, border, or corner is recomputed by this renderer.',
				'ownership: unowned remainder/extension as reported by G4; assignment is rerun after accepted recovery.'
			]
		};
	}
};

/** Assignment-only fallback: a violet marker, never an invented tee outline. */
export const PHANTOM_TEE_RENDER: FeatureRender = {
	units: ['phantomTee'],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = byVerdict(unit, 'accepted');
		const rejected = byVerdict(unit, 'rejected');
		const info = byVerdict(unit, 'info');
		const phantomCenters = accepted.filter((drawable) => isPhantom(drawable));
		return {
			title: `Phantom tee assignment completion -- G4 (${run.configName})`,
			base: 'badgeStage.masks.bright',
			layers: [
				{
					name: 'phantom tee centers (assignment-only)',
					note: 'violet diamond/cross marks trace-emitted phantom centers; appearance is UNKNOWN',
					drawables: phantomCenters
				},
				{
					name: 'phantom recovery candidates rejected',
					note: 'rejection testimony retained when the fallback could not complete assignment',
					drawables: rejected
				},
				...(info.length
					? [
							{
								name: 'phantom recovery trace information',
								note: 'informational evidence retained from the trace',
								drawables: info
							}
						]
					: [])
			],
			notes: [
				...runNotes('phantomTee', unit, run),
				`phantom centers: ${phantomCenters.length} (source: accepted UnitTrace.drawables with visualRole='phantom-center')`,
				'purpose: complete assignment and move on when a tee is missing; this is not a visibility or appearance claim.',
				'appearance: UNKNOWN -- no outline is invented for an assignment-only phantom.',
				'phantom marker: violet center diamond/cross, distinct from regular green detected tee markers.',
				'ownership: assignment output; localization and visual truth are UNKNOWN.'
			]
		};
	}
};

// Short aliases make the intended import seam obvious to feature owners.
export const teeRecoveryRender = TEE_RECOVERY_RENDER;
export const phantomTeeRender = PHANTOM_TEE_RENDER;
