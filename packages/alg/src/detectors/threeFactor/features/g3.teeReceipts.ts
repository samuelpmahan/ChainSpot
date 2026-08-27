// Trace-only receipts for tee recovery and assignment-only phantom tees.
//
// These plans deliberately do not inspect pixels or rebuild geometry. The
// detector owns the coordinates and corners; this module only selects the
// already-emitted drawables by their semantic refs. That keeps the trace,
// CLI receipt, and rendered overlay one-to-one.

import type {
	Drawable,
	FeatureRender,
	FeatureRenderPlan,
	PointDrawable,
	RunTrace,
	UnitTrace
} from './types';
import { teePoseDecoration } from './teePoseVisuals';

function byVerdict(unit: UnitTrace, verdict: 'accepted' | 'rejected' | 'info') {
	return unit.drawables.filter((drawable) => drawable.verdict === verdict);
}

function isCorner(drawable: { readonly type: string; readonly visualRole?: string }): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'tee-corner-tick';
}

function isPhantom(drawable: { readonly visualRole?: string }): boolean {
	return drawable.visualRole === 'phantom-center';
}

function recoveredPoseDecorations(corners: readonly Drawable[]) {
	const groups = new Map<string, Array<{ index: number; point: PointDrawable }>>();
	const unmatched: PointDrawable[] = [];
	for (const drawable of corners) {
		if (drawable.type !== 'point') continue;
		const match = drawable.ref?.match(/^(.*):tee-corner-tick-([0-3])$/);
		if (!match) {
			unmatched.push(drawable);
			continue;
		}
		const entries = groups.get(match[1]) ?? [];
		entries.push({ index: Number(match[2]), point: drawable });
		groups.set(match[1], entries);
	}
	const decoratedCorners: PointDrawable[] = [...unmatched];
	const diagonals: Drawable[] = [];
	for (const [ref, entries] of groups) {
		entries.sort((a, b) => a.index - b.index);
		if (entries.length !== 4 || entries.some((entry, index) => entry.index !== index)) {
			decoratedCorners.push(...entries.map((entry) => entry.point));
			continue;
		}
		const decoration = teePoseDecoration(
			entries.map(({ point }) => [point.xPx, point.yPx] as const),
			ref,
			'presentation geometry connected from the detector-emitted recovery corners'
		);
		decoratedCorners.push(...decoration.cornerTicks);
		diagonals.push(...decoration.diagonals);
	}
	return { corners: decoratedCorners, diagonals };
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
		const pose = recoveredPoseDecorations(corners);
		const shard = accepted.filter((drawable) => drawable.visualRole === 'tee-shard');
		const visibleShardGroups = shard.reduce(
			(sum, drawable) => sum + (drawable.values?.supportingComponents ?? 0),
			0
		);
		return {
			title: `G4 teeRecovery -- post-assignment shard recovery (${run.configName})`,
			base: 'badgeStage.masks.bright',
			layers: [
				{
					name: 'visible shard highlighted (G4 post-assignment recovery)',
					note: 'exact non-occluded white pixels; disconnected shards are counted separately and are never bridged by the renderer',
					drawables: shard
				},
				{
					name: 'tee pose center guides (G4 post-assignment recovery)',
					note: 'one-pixel red diagonals connect the detector-emitted opposite corners; their intersection is the fitted center',
					drawables: pose.diagonals
				},
				{
					name: 'calculated or assumed four corners (G4 post-assignment recovery)',
					note: 'detector-emitted corners shown as small cyan plus signs rotated into the pad-edge axes',
					drawables: pose.corners
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
				`recovered tee pixel sets: ${shard.length} (source: accepted trace drawables with visualRole='tee-shard')`,
				`visible connected shards: ${visibleShardGroups} (source: detector-emitted supportingComponents values after ownership/occlusion subtraction)`,
				`corner drawables: ${corners.length} (source: info trace drawables with visualRole='tee-corner-tick'; expected four when recovery completes)`,
				`center-guide diagonals: ${pose.diagonals.length} (presentation-only connections between opposite detector-emitted corners; expected two per recovered tee)`,
				`rejected candidates: ${rejected.length} (source: UnitTrace.drawables verdict='rejected')`,
				'phase: G4 post-assignment recovery; normal assignment evidence is consumed before this unit and rerun after accepted shards.',
				'C1S=solid 10m; C2D=dashed 20m. Traversed local-component fields: UNKNOWN -- none were emitted in this trace.',
				'acceptance: every non-occluded visible component pixel must contribute to one course-local hollow tee support whose major axis is within 3 degrees of the numbered badge ray.',
				'missing expected tee pixels are UNKNOWN and neutral; OPAQUE pixels are excluded, while ALPHA pixels remain evidence.',
				'appearance: UNKNOWN beyond the accepted visible white component and calculated tee corners.',
				'visual standard: exact green shard pixels, four pad-axis-aligned cyan corner plus signs, and two one-pixel red corner diagonals whose intersection exposes the fitted center.',
				'recovery display is trace-driven: no pixels, fit, border, or corner is recomputed; presentation only connects the emitted corners.',
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
