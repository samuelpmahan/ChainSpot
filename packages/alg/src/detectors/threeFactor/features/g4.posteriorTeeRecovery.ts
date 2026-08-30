/**
 * Experimental posterior tee-recovery reconciliation.
 *
 * This is intentionally a sidecar decision feature first: it consumes the
 * frozen G4 recovery + teeBadgeLock testimony, reopens only the conflict
 * island, and publishes a joint posterior over material shard hypotheses
 * plus NULL. It does NOT rewrite assignment/recoveredTees yet. That lets us
 * ablate and place the mechanism before granting it production custody.
 *
 * "Posterior" here means normalized model weight, not a calibrated real-
 * world probability. The receipt exposes every likelihood term and model
 * provenance so the number cannot masquerade as unexplained certainty.
 */

import type { ABFeatureOperation } from '../../../exec/feature-set';
import type { ExecBoard } from '../../../exec/board';
import type { OperationArtifact } from '../../../exec/gateway';
import type {
	AssignmentEvidence,
	BadgeEvidence,
	BasketEvidence,
	RecoveredTeeInput,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../types';
import type { SpriteMatch } from '../endpoints';
import { buildTeeRecoveryCandidates, type TeeRecoveryCandidate } from './g3.teeRecovery';
import { synthesizePhantomTees } from './g3.phantomTee';
import type { ABFeature, FeatureContext } from './types';

const FEATURE_ID = 'posteriorTeeRecovery';
const UNIT_ID = 'teeBadgeLock';
const RASTER_TOLERANCE_PX = 1.25;

interface TeeBadgeLockLike {
	readonly locks: readonly {
		readonly badgeId: string;
		readonly teeId: string;
		readonly tier: 'visible' | 'recovered';
		readonly hole?: number;
		readonly score: number;
		readonly chordPx: number;
		readonly axisErrorDeg: number | 'UNKNOWN';
	}[];
	readonly abstentions: readonly {
		readonly badgeId: string;
		readonly hole?: number;
	}[];
}

export interface PosteriorEvidenceModel {
	readonly median: number;
	readonly scale: number;
	readonly sampleCount: number;
	readonly provenance: string;
}

export interface PosteriorTeeCandidate {
	readonly kind: 'candidate';
	readonly id: string;
	readonly badgeId: string;
	readonly hole: string | null;
	readonly componentLabels: readonly number[];
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly supportPixels: number;
	readonly unexplainedPixels: number;
	readonly distancePx: number;
	readonly axisErrorDeg: number | null;
	readonly logTerms: {
		readonly support: number;
		readonly distance: number;
		readonly axis: number;
		readonly contradictions: number;
		readonly multiplicityAndPrior: number;
	};
	readonly logWeightVsNull: number;
	posteriorWithinTarget?: number;
}

export interface PosteriorNullCandidate {
	readonly kind: 'null';
	readonly id: 'NULL';
	readonly badgeId: string;
	readonly hole: string | null;
	readonly componentLabels: readonly [];
	readonly logWeightVsNull: 0;
	posteriorWithinTarget?: number;
}

export type PosteriorTeeHypothesis = PosteriorTeeCandidate | PosteriorNullCandidate;

export interface PosteriorJointHypothesis {
	readonly posterior: number;
	readonly logWeight: number;
	readonly selections: readonly PosteriorTeeHypothesis[];
}

export interface PosteriorPhantomProposal {
	readonly badgeId: string;
	readonly hole: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly provenance: RecoveredTeeInput['provenance'];
}

export interface PosteriorTeeRecoveryEvidence {
	readonly schema: 'posterior-tee-recovery@1';
	readonly enabled: boolean;
	readonly status: 'disabled' | 'no-conflicts' | 'resolved' | 'abstained-too-large';
	readonly evidenceModels: {
		readonly distance: PosteriorEvidenceModel;
		readonly axis: PosteriorEvidenceModel;
	};
	readonly targetBadgeIds: readonly string[];
	readonly targets: readonly {
		readonly badgeId: string;
		readonly hole: string | null;
		readonly consideredComponents: number;
		readonly topHypotheses: readonly PosteriorTeeHypothesis[];
	}[];
	readonly jointTop: readonly PosteriorJointHypothesis[];
	readonly phantomProposals: readonly PosteriorPhantomProposal[];
	readonly completions: {
		readonly unaffectedLocks: number;
		readonly observable: number;
		readonly phantom: number;
		readonly unresolvedNulls: number;
		readonly total: number;
	};
}

interface PosteriorKnobs {
	readonly observableToNullPriorOdds: number;
	readonly topKPerTarget: number;
	readonly maxConflictTargets: number;
	readonly supportLogWeight: number;
	readonly distanceTailWeight: number;
	readonly axisWeight: number;
	readonly distanceScaleFloorPx: number;
	readonly axisScaleFloorDeg: number;
	readonly contradictionOddsPerPixel: number;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function median(values: readonly number[]): number {
	const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return 0;
	const m = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

function robustModel(
	values: readonly number[],
	floor: number,
	provenance: string
): PosteriorEvidenceModel {
	const finiteValues = values.filter(Number.isFinite);
	if (!finiteValues.length) {
		return {
			median: 0,
			scale: floor,
			sampleCount: 0,
			provenance: `${provenance}; UNKNOWN/no samples`
		};
	}
	const center = median(finiteValues);
	const mad = median(finiteValues.map((value) => Math.abs(value - center)));
	return {
		median: center,
		scale: Math.max(floor, 1.4826 * mad),
		sampleCount: finiteValues.length,
		provenance
	};
}

function axialErrorDeg(candidate: TeeRecoveryCandidate): number | null {
	const a = candidate.badgeAxisAngleRad;
	const b = candidate.teeToBadgeAngleRad;
	if (!finite(a) || !finite(b)) return null;
	const d = Math.atan2(Math.sin(a - b), Math.cos(a - b));
	return (Math.abs(d) * 180) / Math.PI;
}

function explains(candidate: TeeRecoveryCandidate, point: readonly [number, number]): boolean {
	const fit = candidate.fit;
	const dx = point[0] - fit.centerXPx;
	const dy = point[1] - fit.centerYPx;
	const c = Math.cos(fit.angleRad);
	const s = Math.sin(fit.angleRad);
	const u = dx * c + dy * s;
	const v = -dx * s + dy * c;
	const hw = fit.halfWidthPx + RASTER_TOLERANCE_PX;
	const hh = fit.halfHeightPx + RASTER_TOLERANCE_PX;
	if (Math.abs(u) > hw || Math.abs(v) > hh) return false;
	const thickness = Math.max(
		0,
		fit.supportThicknessPx ?? Math.min(fit.halfWidthPx, fit.halfHeightPx)
	);
	return (
		Math.abs(u) >= fit.halfWidthPx - thickness - RASTER_TOLERANCE_PX ||
		Math.abs(v) >= fit.halfHeightPx - thickness - RASTER_TOLERANCE_PX
	);
}

function componentLabels(candidate: TeeRecoveryCandidate): number[] {
	const labels = new Set<number>();
	for (const id of candidate.supportingComponentIds) {
		const componentGroup = id.split(':')[0] ?? '';
		for (const token of componentGroup.split('+')) {
			const label = Number(token);
			if (Number.isFinite(label)) labels.add(label);
		}
	}
	return [...labels].sort((a, b) => a - b);
}

function studentTLikeLogLikelihood(z: number, weight: number): number {
	return -weight * Math.log1p((z * z) / 3);
}

function scoreCandidate(
	candidate: TeeRecoveryCandidate,
	badge: BadgeEvidence,
	consideredComponents: number,
	distanceModel: PosteriorEvidenceModel,
	axisModel: PosteriorEvidenceModel,
	knobs: PosteriorKnobs
): PosteriorTeeCandidate {
	const fit = candidate.localizationFit ?? candidate.fit;
	const centerYPx =
		fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : (candidate.viewportTopPx ?? 0));
	const distancePx = Math.hypot(fit.centerXPx - badge.cxPx, centerYPx - badge.cyPx);
	const axisError = axialErrorDeg(candidate);
	const unexplainedPixels = candidate.fragmentPixels.filter(
		(point) => !explains(candidate, point)
	).length;

	const supportTerm = knobs.supportLogWeight * Math.log1p(candidate.fragmentPixels.length);
	const distanceTerm =
		distanceModel.sampleCount === 0
			? 0
			: studentTLikeLogLikelihood(
					(distancePx - distanceModel.median) / distanceModel.scale,
					knobs.distanceTailWeight
				);
	const axisTerm =
		axisModel.sampleCount === 0
			? 0
			: -0.5 *
				knobs.axisWeight *
				(((axisError ?? axisModel.median + 3 * axisModel.scale) - axisModel.median) /
					axisModel.scale) **
					2;
	const contradictionTerm = Math.log(knobs.contradictionOddsPerPixel) * unexplainedPixels;
	const multiplicityAndPriorTerm =
		Math.log(knobs.observableToNullPriorOdds) - Math.log(Math.max(1, consideredComponents));
	const logWeightVsNull =
		supportTerm + distanceTerm + axisTerm + contradictionTerm + multiplicityAndPriorTerm;

	return {
		kind: 'candidate',
		id: candidate.id,
		badgeId: badge.detId,
		hole: badge.label,
		componentLabels: componentLabels(candidate),
		centerXPx: fit.centerXPx,
		centerYPx,
		supportPixels: candidate.fragmentPixels.length,
		unexplainedPixels,
		distancePx,
		axisErrorDeg: axisError,
		logTerms: {
			support: supportTerm,
			distance: distanceTerm,
			axis: axisTerm,
			contradictions: contradictionTerm,
			multiplicityAndPrior: multiplicityAndPriorTerm
		},
		logWeightVsNull
	};
}

function normalizeTarget(hypotheses: PosteriorTeeHypothesis[]): PosteriorTeeHypothesis[] {
	const maxLog = Math.max(0, ...hypotheses.map((hypothesis) => hypothesis.logWeightVsNull));
	const weights = hypotheses.map((hypothesis) => Math.exp(hypothesis.logWeightVsNull - maxLog));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	hypotheses.forEach((hypothesis, index) => {
		hypothesis.posteriorWithinTarget = weights[index]! / total;
	});
	return hypotheses.sort((a, b) => (b.posteriorWithinTarget ?? 0) - (a.posteriorWithinTarget ?? 0));
}

function sharesEvidence(hypothesis: PosteriorTeeHypothesis, used: ReadonlySet<number>): boolean {
	return hypothesis.componentLabels.some((label) => used.has(label));
}

function enumerateJoint(
	targets: readonly { readonly hypotheses: readonly PosteriorTeeHypothesis[] }[],
	topKPerTarget: number
): Array<{ logWeight: number; selections: PosteriorTeeHypothesis[] }> {
	const out: Array<{ logWeight: number; selections: PosteriorTeeHypothesis[] }> = [];
	function visit(
		index: number,
		used: Set<number>,
		selections: PosteriorTeeHypothesis[],
		logWeight: number
	): void {
		if (index === targets.length) {
			out.push({ logWeight, selections: [...selections] });
			return;
		}
		const choices = targets[index]!.hypotheses.slice(0, topKPerTarget);
		for (const hypothesis of choices) {
			if (sharesEvidence(hypothesis, used)) continue;
			const nextUsed = new Set(used);
			for (const label of hypothesis.componentLabels) nextUsed.add(label);
			selections.push(hypothesis);
			visit(index + 1, nextUsed, selections, logWeight + hypothesis.logWeightVsNull);
			selections.pop();
		}
	}
	visit(0, new Set(), [], 0);
	return out.sort((a, b) => b.logWeight - a.logWeight);
}

function normalizeJoint(
	joint: readonly { readonly logWeight: number; readonly selections: PosteriorTeeHypothesis[] }[]
): PosteriorJointHypothesis[] {
	if (!joint.length) return [];
	const maxLog = joint[0]!.logWeight;
	const weights = joint.map((row) => Math.exp(row.logWeight - maxLog));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	return joint.slice(0, 10).map((row, index) => ({
		posterior: weights[index]! / total,
		logWeight: row.logWeight,
		selections: row.selections
	}));
}

function phantomHole(note: string): number | null {
	const match = note.match(/\bhole\s+(\d+)\b/);
	return match ? Number(match[1]) : null;
}

function emptyModel(name: string): PosteriorEvidenceModel {
	return { median: 0, scale: 1, sampleCount: 0, provenance: `${name}; not evaluated` };
}

function disabledEvidence(enabled: boolean): PosteriorTeeRecoveryEvidence {
	return {
		schema: 'posterior-tee-recovery@1',
		enabled,
		status: enabled ? 'no-conflicts' : 'disabled',
		evidenceModels: { distance: emptyModel('distance'), axis: emptyModel('axis') },
		targetBadgeIds: [],
		targets: [],
		jointTop: [],
		phantomProposals: [],
		completions: { unaffectedLocks: 0, observable: 0, phantom: 0, unresolvedNulls: 0, total: 0 }
	};
}

function inferPosterior(
	board: ExecBoard,
	ctx: FeatureContext,
	knobs: PosteriorKnobs
): PosteriorTeeRecoveryEvidence {
	const measurement = board.get<ThreeFactorMeasurement>('measurement');
	const assignment = board.get<ThreeFactorAssignment>('assignment');
	const teeBadge = board.get<TeeBadgeLockLike>('teeBadgeLock');
	const badges = board.get<readonly BadgeEvidence[]>('badges');
	const baskets = board.get<readonly BasketEvidence[]>('baskets');
	const visibleTees = board.get<readonly TeeEvidence[]>('tees');
	const stage = board.get<Parameters<typeof buildTeeRecoveryCandidates>[0]>('stage');
	const viewport = board.get<{ readonly topPx: number }>('viewport');
	const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;

	const visibleLocks = teeBadge.locks.filter(
		(lock) => lock.tier === 'visible' && finite(lock.chordPx)
	);
	const distanceModel = robustModel(
		visibleLocks.map((lock) => lock.chordPx),
		knobs.distanceScaleFloorPx,
		`median/MAD over ${visibleLocks.length} frozen visible teeBadgeLock chordPx values`
	);
	const axisSamples = visibleLocks
		.map((lock) => lock.axisErrorDeg)
		.filter((value): value is number => finite(value));
	const axisModel = robustModel(
		axisSamples,
		knobs.axisScaleFloorDeg,
		`median/MAD over ${axisSamples.length} frozen visible teeBadgeLock axis-error values`
	);

	const targetBadgeIds = new Set<string>(teeBadge.abstentions.map((row) => row.badgeId));
	const lockByBadge = new Map(teeBadge.locks.map((row) => [row.badgeId, row]));
	const assignmentByTee = new Map(assignment.assignments.map((row) => [row.teeId, row]));
	for (const lock of teeBadge.locks) {
		if (lock.tier !== 'recovered') continue;
		const assignmentOwner = assignmentByTee.get(lock.teeId);
		if (!assignmentOwner || assignmentOwner.badgeId === lock.badgeId) continue;
		targetBadgeIds.add(lock.badgeId);
		if (!lockByBadge.has(assignmentOwner.badgeId)) targetBadgeIds.add(assignmentOwner.badgeId);
	}

	if (targetBadgeIds.size === 0) {
		return {
			schema: 'posterior-tee-recovery@1',
			enabled: true,
			status: 'no-conflicts',
			evidenceModels: { distance: distanceModel, axis: axisModel },
			targetBadgeIds: [],
			targets: [],
			jointTop: [],
			phantomProposals: [],
			completions: {
				unaffectedLocks: teeBadge.locks.length,
				observable: 0,
				phantom: 0,
				unresolvedNulls: 0,
				total: teeBadge.locks.length
			}
		};
	}

	if (targetBadgeIds.size > knobs.maxConflictTargets) {
		return {
			schema: 'posterior-tee-recovery@1',
			enabled: true,
			status: 'abstained-too-large',
			evidenceModels: { distance: distanceModel, axis: axisModel },
			targetBadgeIds: [...targetBadgeIds],
			targets: [],
			jointTop: [],
			phantomProposals: [],
			completions: {
				unaffectedLocks: teeBadge.locks.filter((lock) => !targetBadgeIds.has(lock.badgeId)).length,
				observable: 0,
				phantom: 0,
				unresolvedNulls: targetBadgeIds.size,
				total: teeBadge.locks.filter((lock) => !targetBadgeIds.has(lock.badgeId)).length
			}
		};
	}

	const basketFallback = baskets[0]?.detId ?? 'UNKNOWN';
	const assignmentMask = {
		assignments: badges
			.filter((badge) => /^\d+$/.test(badge.label ?? '') && !targetBadgeIds.has(badge.detId))
			.map((badge) => ({ badgeId: badge.detId, basketId: basketFallback }))
	};
	const built = buildTeeRecoveryCandidates(stage, badges, baskets, visibleTees, viewport.topPx, {
		assignment: assignmentMask,
		sprites,
		occlusion: ctx.occlusion
	});

	const posteriorTargets = built.searchOutcomes
		.filter((outcome) => targetBadgeIds.has(outcome.badgeId))
		.map((outcome) => {
			const badge = badges.find((candidate) => candidate.detId === outcome.badgeId)!;
			const raw = [outcome.winner, ...outcome.runnerUps].filter(
				(value): value is TeeRecoveryCandidate => value !== undefined
			);
			const hypotheses: PosteriorTeeHypothesis[] = raw.map((candidate) =>
				scoreCandidate(
					candidate,
					badge,
					outcome.consideredComponents,
					distanceModel,
					axisModel,
					knobs
				)
			);
			hypotheses.push({
				kind: 'null',
				id: 'NULL',
				badgeId: badge.detId,
				hole: badge.label,
				componentLabels: [],
				logWeightVsNull: 0
			});
			return {
				badgeId: badge.detId,
				hole: badge.label,
				consideredComponents: outcome.consideredComponents,
				hypotheses: normalizeTarget(hypotheses)
			};
		});

	const joint = enumerateJoint(posteriorTargets, knobs.topKPerTarget);
	const jointTop = normalizeJoint(joint);
	const map = jointTop[0];
	const nullSelections =
		map?.selections.filter(
			(selection): selection is PosteriorNullCandidate => selection.kind === 'null'
		) ?? [];
	const rawPhantoms = nullSelections.length
		? synthesizePhantomTees(measurement, assignment.assignments, 0, nullSelections.length)
		: [];
	const phantomProposals: PosteriorPhantomProposal[] = [];
	const unresolvedNulls: PosteriorNullCandidate[] = [];
	for (const selection of nullSelections) {
		const hole = Number(selection.hole);
		const phantom = rawPhantoms.find(
			(candidate) => phantomHole(candidate.provenance.note) === hole
		);
		if (!Number.isInteger(hole) || !phantom) {
			unresolvedNulls.push(selection);
			continue;
		}
		phantomProposals.push({
			badgeId: selection.badgeId,
			hole,
			xPx: phantom.xPx,
			yPx: phantom.yPx,
			provenance: phantom.provenance
		});
	}

	const unaffectedLocks = teeBadge.locks.filter((lock) => !targetBadgeIds.has(lock.badgeId)).length;
	const observable =
		map?.selections.filter((selection) => selection.kind === 'candidate').length ?? 0;
	const phantom = phantomProposals.length;

	return {
		schema: 'posterior-tee-recovery@1',
		enabled: true,
		status: 'resolved',
		evidenceModels: { distance: distanceModel, axis: axisModel },
		targetBadgeIds: [...targetBadgeIds],
		targets: posteriorTargets.map((target) => ({
			badgeId: target.badgeId,
			hole: target.hole,
			consideredComponents: target.consideredComponents,
			topHypotheses: target.hypotheses.slice(0, knobs.topKPerTarget)
		})),
		jointTop,
		phantomProposals,
		completions: {
			unaffectedLocks,
			observable,
			phantom,
			unresolvedNulls: unresolvedNulls.length,
			total: unaffectedLocks + observable + phantom
		}
	};
}

function executePosteriorTeeRecovery(board: ExecBoard, ctx: FeatureContext): void {
	const stop = ctx.span(UNIT_ID);
	const state = ctx.resolve(posteriorTeeRecoveryFeature);
	const evidence = state.enabled
		? inferPosterior(board, ctx, state.knobs as unknown as PosteriorKnobs)
		: disabledEvidence(false);
	board.set(FEATURE_ID, evidence);
	ctx.measure(UNIT_ID, 'posteriorTargets', evidence.targetBadgeIds.length);
	ctx.measure(UNIT_ID, 'posteriorObservableCompletions', evidence.completions.observable);
	ctx.measure(UNIT_ID, 'posteriorPhantomCompletions', evidence.completions.phantom);
	ctx.measure(UNIT_ID, 'posteriorTotalCompletions', evidence.completions.total);
	ctx.measure(UNIT_ID, 'posteriorUnresolvedNulls', evidence.completions.unresolvedNulls);
	stop();
}

function artifacts(board: ExecBoard): readonly OperationArtifact[] {
	const evidence = board.get<PosteriorTeeRecoveryEvidence>(FEATURE_ID);
	return [
		{
			kind: 'measurementTable',
			id: 'posteriorTeeRecovery.evidence',
			bytes: new TextEncoder().encode(JSON.stringify(evidence))
		}
	];
}

export const posteriorTeeRecoveryOperation: ABFeatureOperation = {
	spec: {
		id: FEATURE_ID,
		kind: 'decide',
		gate: 'G4',
		unit: UNIT_ID,
		consumes: [
			'stage',
			'badges',
			'baskets',
			'tees',
			'sprites',
			'viewport',
			'measurement',
			'assignment',
			'teeBadgeLock'
		],
		produces: [FEATURE_ID],
		features: [FEATURE_ID],
		note: 'posterior reconciliation over the evidence-derived tee-recovery conflict island; publishes sidecar decisions only'
	},
	run(board, ctx) {
		executePosteriorTeeRecovery(board, ctx);
	},
	extractArtifacts: artifacts
};

export const posteriorTeeRecoveryFeature = {
	id: FEATURE_ID,
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note: 'Experimental posterior tee recovery: jointly rank shard/NULL hypotheses using course-local evidence models. Sidecar only until ablation decides its proper G4 custody.',
	knobs: {
		observableToNullPriorOdds: {
			default: 17,
			note: 'Prior odds for some observable shard hypothesis versus NULL before candidate multiplicity; 17 is the spike prior of roughly one NULL slot per 18-hole card.',
			validate: (value: unknown) =>
				finite(value) && value > 0 ? null : 'observableToNullPriorOdds must be > 0'
		},
		topKPerTarget: {
			default: 12,
			note: 'Maximum normalized target hypotheses admitted to exact joint conflict enumeration.',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 32
					? null
					: 'topKPerTarget must be an integer in [1,32]'
		},
		maxConflictTargets: {
			default: 4,
			note: 'Exact joint enumeration is intentionally limited to small ambiguity islands; larger islands abstain instead of approximating silently.',
			validate: (value: unknown) =>
				Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 6
					? null
					: 'maxConflictTargets must be an integer in [1,6]'
		},
		supportLogWeight: {
			default: 2,
			note: 'Multiplier on log1p(visible supporting pixel count).',
			validate: (value: unknown) =>
				finite(value) && value >= 0 ? null : 'supportLogWeight must be >= 0'
		},
		distanceTailWeight: {
			default: 2,
			note: 'Weight of the heavy-tailed course-local badge-distance likelihood.',
			validate: (value: unknown) =>
				finite(value) && value >= 0 ? null : 'distanceTailWeight must be >= 0'
		},
		axisWeight: {
			default: 1,
			note: 'Weight of the course-local robust axis-error likelihood.',
			validate: (value: unknown) => (finite(value) && value >= 0 ? null : 'axisWeight must be >= 0')
		},
		distanceScaleFloorPx: {
			default: 1,
			note: 'Numerical floor for the per-image median/MAD tee-to-badge distance model.',
			validate: (value: unknown) =>
				finite(value) && value > 0 ? null : 'distanceScaleFloorPx must be > 0'
		},
		axisScaleFloorDeg: {
			default: 0.5,
			note: 'Numerical floor for the per-image median/MAD axis-error model.',
			validate: (value: unknown) =>
				finite(value) && value > 0 ? null : 'axisScaleFloorDeg must be > 0'
		},
		contradictionOddsPerPixel: {
			default: 0.5,
			note: 'Likelihood multiplier for each visible candidate pixel not explained by the fitted tee support; smooth evidence, not a hard disqualifier.',
			validate: (value: unknown) =>
				finite(value) && value > 0 && value <= 1
					? null
					: 'contradictionOddsPerPixel must be in (0,1]'
		}
	},
	operations: [posteriorTeeRecoveryOperation]
} satisfies ABFeature;
