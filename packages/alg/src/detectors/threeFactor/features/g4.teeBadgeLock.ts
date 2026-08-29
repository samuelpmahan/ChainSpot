/**
 * G4 teeBadgeLock: an opt-in, independent tee↔badge ownership decision.
 *
 * The semantic set owns the executable operation.  The ABFeature is only its
 * default-OFF declaration and render seam; keeping those separate means a
 * caller can compose this deviation without changing the frozen engine plan.
 */

import type { ABFeatureOperation } from '../../../exec/feature-set';
import type { OperationArtifact } from '../../../exec/gateway';
import type { ExecBoard } from '../../../exec/board';
import type {
	BadgeEvidence,
	RawPairEvidence,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../types';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';
import { g4ScoringFeature } from './g4.scoring';
import {
	buildTeeBadgeLockEvidence,
	collapseTeeBadgePaths,
	maximumWeightTeeBadgeMatching,
	scoreTeeBadgeCandidates,
	type TeeBadgeBadgeOrder,
	type TeeBadgeLockEvidence,
	type TeeBadgeLockMathKnobs,
	type TeeBadgeLockScoredCandidate,
	type TeeBadgeTeeOrder
} from './g4.teeBadgeLockMath';
import { TEE_BADGE_LOCK_RENDER } from './g4.teeBadgeLockReceipt';

export interface TeeBadgeLockMeasurement extends ThreeFactorMeasurement {
	readonly field: ThreeFactorMeasurement['field'];
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function scoringKnobs(
	ctx: FeatureContext,
	measurement: TeeBadgeLockMeasurement
): TeeBadgeLockMathKnobs {
	const configured = ctx.resolve(g4ScoringFeature).knobs as Record<string, unknown>;
	const alignmentPower = measurement.parameters?.alignmentPower;
	const worstWindowSrcPx = measurement.parameters?.worstWindowSrcPx;
	const minWindowCells = configured.minWindowCells;
	const orientationSigma = configured.teeOrientationSigmaDeg ?? configured.teeOrientationSigma;
	if (
		!finite(alignmentPower) ||
		!finite(worstWindowSrcPx) ||
		!finite(minWindowCells) ||
		!finite(orientationSigma)
	) {
		throw new Error(
			'teeBadgeLock: scoring provenance is incomplete; alignmentPower and worstWindowSrcPx must come from measurement.parameters, while minWindowCells and teeOrientationSigmaDeg must come from resolved scoring.'
		);
	}
	return {
		alignmentPower,
		worstWindowSrcPx,
		minWindowCells,
		teeOrientationSigmaDeg: orientationSigma
	};
}

function asBadgeOrder(badges: readonly BadgeEvidence[] | undefined): readonly TeeBadgeBadgeOrder[] {
	return (badges ?? []).map((badge) => ({
		detId: badge.detId,
		label: badge.label,
		cxPx: badge.cxPx,
		cyPx: badge.cyPx
	}));
}

function asTeeOrder(tees: readonly TeeEvidence[] | undefined): readonly TeeBadgeTeeOrder[] {
	return (tees ?? []).map((tee) => ({
		detId: tee.detId,
		tier: tee.tier,
		xPx: tee.xPx,
		yPx: tee.yPx,
		angleRad: tee.angleRad,
		pad: tee.pad
	}));
}

function disabledEvidence(measurement: TeeBadgeLockMeasurement): TeeBadgeLockEvidence {
	return buildTeeBadgeLockEvidence(
		{ candidates: [], locks: [], unmatchedBadgeIds: [], unusedTeeIds: [] },
		{ measurement }
	);
}

function axisSourceCode(source: TeeBadgeLockScoredCandidate['axisSource']): number {
	if (source === 'TeeEvidence.pad.minAreaPose.angleRad') return 0;
	if (source === 'TeeEvidence.angleRad') return 1;
	if (source === 'TeeEvidence.pad.angleRad') return 2;
	return 3;
}

function numericLockValues(
	lock: TeeBadgeLockScoredCandidate & {
		readonly tier?: 'visible' | 'recovered';
		readonly hole?: number;
	}
): Record<string, number> {
	const values: Record<string, number> = {
		score: lock.score,
		weakAligned: lock.weakAlignedSupport,
		efficiency: lock.pathEfficiency,
		axisSourceCode: axisSourceCode(lock.axisSource),
		pathPoints: lock.teeBadgePath.length,
		recovered: lock.tier === 'recovered' ? 1 : 0
	};
	if (finite(lock.hole)) values.hole = lock.hole;
	if (finite(lock.axisErrorDeg)) values.axisErrorDeg = lock.axisErrorDeg;
	if (finite(lock.runnerUpMargin)) values.margin = lock.runnerUpMargin;
	values.tierCode = lock.tier === 'recovered' ? 1 : 0;
	return values;
}

function abstentionValues(abstention: TeeBadgeLockEvidence['abstentions'][number]): Record<string, number> {
	const values: Record<string, number> = {
		kindCode: abstention.kind === 'conflict' ? 1 : 0
	};
	if (finite(abstention.hole)) values.hole = abstention.hole;
	if (finite(abstention.bestScore)) values.bestScore = abstention.bestScore;
	if (finite(abstention.winningHole)) values.winningHole = abstention.winningHole;
	if (finite(abstention.winningScore)) values.winningScore = abstention.winningScore;
	return values;
}

function emitDrawables(
	ctx: FeatureContext,
	evidence: TeeBadgeLockEvidence,
	badges: readonly TeeBadgeBadgeOrder[]
): void {
	const badgeById = new Map(badges.map((badge) => [badge.detId, badge]));
	for (const abstention of evidence.abstentions) {
		const badge = badgeById.get(abstention.badgeId);
		const ref = `teeBadgeLockAbstention:${encodeURIComponent(abstention.badgeId)}`;
		ctx.overlay('teeBadgeLock', {
			type: 'point',
			xPx: badge?.cxPx ?? 0,
			yPx: badge?.cyPx ?? 0,
			verdict: 'rejected',
			visualRole: 'tee-badge-abstention',
			ref,
			reason: abstention.reason,
			values: abstentionValues(abstention)
		});
	}
	for (const lock of evidence.locks) {
		const ref = `teeBadgeLock:${encodeURIComponent(lock.badgeId)}:${encodeURIComponent(lock.teeId)}`;
		// lock.hole is the exact-label hole number this lock is already tied to
		// (buildTeeBadgeLockEvidence copies it from the badge's G1 digit read).
		// The CLI receipt (g4.teeBadgeLockReceipt.ts) surfaces it as its own
		// `hole` column, but this reason string is what a human actually reads
		// on hover in the LAB SVG viewer (src/routes/lab/+page.svelte renders
		// `<title>{unit.id} {d.verdict}: {d.reason} {d.ref}</title>` verbatim),
		// so it must not leave the raw badge/tee detector ids unexplained there.
		const holeNote = typeof lock.hole === 'number' ? `hole=H${lock.hole}; ` : '';
		ctx.overlay('teeBadgeLock', {
			type: 'polyline',
			path: lock.teeBadgePath,
			verdict: 'accepted',
			visualRole: 'tee-badge-path',
			ref,
			reason: `${holeNote}max-weight lock; exact routed testimony; no basket evidence read`,
			values: numericLockValues(lock)
		});
	}
}

function executeTeeBadgeLock(
	board: ExecBoard,
	ctx: FeatureContext,
	measurement: TeeBadgeLockMeasurement,
	tees: readonly TeeEvidence[],
	rawPairs: readonly RawPairEvidence[]
): void {
	const stop = ctx.span('teeBadgeLock');
	const state = ctx.resolve(teeBadgeLockFeature);
	const badges = asBadgeOrder(measurement.badges);
	const teeOrder = asTeeOrder(tees);

	const collapseStop = ctx.span('teeBadgeLock.candidateCollapse');
	const collapsed = state.enabled ? collapseTeeBadgePaths(rawPairs) : [];
	collapseStop();

	const scoreStop = ctx.span('teeBadgeLock.score');
	const scored =
		state.enabled && collapsed.length > 0
			? scoreTeeBadgeCandidates({
					candidates: collapsed,
					field: measurement.field,
					tees: teeOrder,
					badges,
					viewportTopPx: measurement.viewport?.topPx ?? 0,
					knobs: scoringKnobs(ctx, measurement)
				})
			: [];
	scoreStop();

	const matchStop = ctx.span('teeBadgeLock.match');
	const selected = state.enabled
		? maximumWeightTeeBadgeMatching(scored, { badges, tees: teeOrder })
		: undefined;
	matchStop();

	const publishStop = ctx.span('teeBadgeLock.publish');
	const evidence = selected
		? buildTeeBadgeLockEvidence(selected, { badges, tees: teeOrder, measurement })
		: disabledEvidence(measurement);
	if (state.enabled) emitDrawables(ctx, evidence, badges);
	ctx.measure('teeBadgeLock', 'candidates', evidence.candidates.length);
	ctx.measure('teeBadgeLock', 'locks', evidence.locks.length);
	ctx.measure(
		'teeBadgeLock',
		'visibleLocks',
		evidence.locks.filter((lock) => lock.tier === 'visible').length
	);
	ctx.measure(
		'teeBadgeLock',
		'recoveredLocks',
		evidence.locks.filter((lock) => lock.tier === 'recovered').length
	);
	ctx.measure('teeBadgeLock', 'unmatchedBadges', evidence.unmatchedBadgeIds.length);
	ctx.measure('teeBadgeLock', 'unusedTees', evidence.unusedTeeIds.length);
	board.set('teeBadgeLock', evidence);
	publishStop();
	stop();
}

function measurementTable(board: ExecBoard): readonly OperationArtifact[] {
	const evidence = board.get<TeeBadgeLockEvidence>('teeBadgeLock');
	return [
		{
			kind: 'measurementTable',
			id: 'teeBadgeLock.evidence',
			bytes: new TextEncoder().encode(JSON.stringify(evidence))
		}
	];
}

/** Default-OFF G4 deviation.  Operation ownership remains with the semantic
 * set, hence `operations` is deliberately undefined. */
export const teeBadgeLockFeature = {
	id: 'teeBadgeLock',
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	knobs: {},
	render: TEE_BADGE_LOCK_RENDER
} satisfies ABFeature;

/** Legacy engine descriptor used by the chronology seam.  Production ABFeature
 * sets use teeBadgeLockOperation below, whose dotted slots make custody
 * explicit and never expose the mutable assignment object. */
export const teeBadgeLockUnit: EngineUnit = {
	id: 'teeBadgeLock',
	gate: 'G4',
	consumes: ['measurement', 'assignment'],
	produces: ['teeBadgeLock'],
	note: 'tee↔badge ownership from exact reversed routed testimony; production custody is owned by teeBadgeLockOperation',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const measurement = board.get<TeeBadgeLockMeasurement>('measurement');
		const assignment = board.get<ThreeFactorAssignment>('assignment');
		const tees = assignment.tees;
		const rawPairs = assignment.scoredPairs.map((pair) => pair.raw);
		executeTeeBadgeLock(board as unknown as ExecBoard, ctx, measurement, tees, rawPairs);
	}
};

/** Semantic-set operation.  It reads exactly the three declared dotted slots,
 * including while OFF, and writes only `teeBadgeLock`. */
export const teeBadgeLockOperation: ABFeatureOperation = {
	spec: {
		id: 'teeBadgeLock',
		kind: 'decide',
		gate: 'G4',
		unit: 'teeBadgeLock',
		consumes: ['measurement', 'assignment.tees', 'assignment.rawPairs'],
		produces: ['teeBadgeLock'],
		features: ['teeBadgeLock', 'scoring'],
		note: 'maximum-weight independent tee↔badge matching over exact reversed routed testimony; no basket evidence is read'
	},
	run(board, ctx) {
		const measurement = board.get<TeeBadgeLockMeasurement>('measurement');
		const tees = board.get<readonly TeeEvidence[]>('assignment.tees');
		const rawPairs = board.get<readonly RawPairEvidence[]>('assignment.rawPairs');
		// Reads above are intentionally unconditional: the gateway receipt can
		// prove OFF custody rather than hiding a missing dependency.
		executeTeeBadgeLock(board, ctx, measurement, tees, rawPairs);
	},
	extractArtifacts: measurementTable
};
