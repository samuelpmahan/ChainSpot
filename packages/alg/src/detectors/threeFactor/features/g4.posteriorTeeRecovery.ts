/**
 * Experimental posterior tee-recovery reconciliation.
 *
 * It consumes the frozen G4 recovery + teeBadgeLock testimony, reopens only
 * the conflict island, and ranks material shard hypotheses against NULL.
 *
 * A selected hypothesis is then written down as a REAL recovered tee, not as a
 * sidecar opinion: a recovered tee is as valid as a visible one, it is just
 * recorded differently. That means a wrong pick shows up on the endpoint image
 * where a human sees it, instead of hiding in a table nobody renders.
 * It rewrites `assignment` with those exact tee-to-badge decisions while
 * leaving basket selection to the existing pair evidence.
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
import { assignThreeFactor, type SearchKnobs } from '../assignment';
import type { RibbonKnobs } from '../ribbon';
import type { RoutingKnobs } from '../routing';
import type { ScoringKnobs, ZfitKnobs } from '../scoring';
import { buildTeeRecoveryCandidates, type TeeRecoveryCandidate } from './g3.teeRecovery';
import { synthesizePhantomTees } from './g3.phantomTee';
import { g4ScoringFeature } from './g4.scoring';
import { g4SearchFeature } from './g4.search';
import { g5RibbonFeature } from './g5.ribbon';
import { g5RoutingFeature } from './g5.routing';
import { zfitFeature } from './g5.zfit';
import type { ABFeature, FeatureContext } from './types';
import { POSTERIOR_TEE_RECOVERY_RENDER } from './g4.posteriorTeeRecoveryReceipt';

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

/** Publish the decision as REAL TEES.
 *
 * A recovered tee is just as valid as a visible one — it is written down
 * differently, not believed less. So when the posterior selects a hypothesis it
 * appends a genuine RecoveredTeeInput to `recoveredTees`, exactly as G3's
 * teeRecovery and phantomTee do, and the run's endpoint image draws it with
 * every other tee. If a pick is wrong it is wrong ON THE MAP, where a human
 * sees it, instead of buried in a sidecar table nobody renders.
 *
 * Geometry is forwarded verbatim from the evidence; nothing is re-derived.
 */
interface PublishedRecoveredTees {
	readonly recoveredTees: readonly RecoveredTeeInput[];
	// Frozen tee ids (teeBadgeLock's own `tee-recovered-N` vocabulary) the
	// posterior is overruling. commitPosteriorAssignments uses this -- not
	// x/y coordinates -- to drop exactly these entries from the pre-posterior
	// `assignment.tees` it otherwise leaves untouched; see C1 in the mechanism
	// note on commitPosteriorAssignments.
	readonly supersededTeeIds: ReadonlySet<string>;
}

function publishRecoveredTees(
	board: ExecBoard,
	ctx: FeatureContext,
	evidence: PosteriorTeeRecoveryEvidence,
	badges: readonly BadgeEvidence[]
): PublishedRecoveredTees {
	const badgeById = new Map(badges.map((badge) => [badge.detId, badge]));
	// A reopened badge already owns a frozen RECOVERED tee, and that tee is
	// exactly what the posterior just overruled. Appending without retiring it
	// would leave the badge owning two endpoints and the run reporting more
	// locks than badges -- so the superseded tees are dropped by position here.
	// Visible-tier tees are never touched: those were observed, not inferred.
	const teeBadge = board.get<TeeBadgeLockLike>('teeBadgeLock');
	const teeById = new Map(
		board.get<readonly TeeEvidence[]>('assignment.tees').map((tee) => [tee.detId, tee])
	);
	const targets = new Set(evidence.targetBadgeIds);
	const superseded: { x: number; y: number }[] = [];
	const supersededTeeIds = new Set<string>();
	for (const lock of teeBadge.locks) {
		if (lock.tier !== 'recovered' || !targets.has(lock.badgeId)) continue;
		const tee = teeById.get(lock.teeId);
		if (tee && finite(tee.xPx) && finite(tee.yPx)) {
			superseded.push({ x: tee.xPx, y: tee.yPx });
			supersededTeeIds.add(lock.teeId);
			// The render layer must drop the G3 shard this overrules, or the
			// badge shows two endpoints. Match by BADGE IDENTITY, not position:
			// G3 draws its shards as `pixelSet` (no centre point) with a ref of
			// `tee-shard-<badgeId>-<componentGroup>:tee-shard`, so the badge id
			// is the only thing both sides reliably share.
			ctx.overlay(UNIT_ID, {
				type: 'point',
				xPx: tee.xPx,
				yPx: tee.yPx,
				verdict: 'rejected',
				visualRole: 'tee-rejection',
				ref: `posteriorTeeRecovery:retired:${encodeURIComponent(lock.badgeId)}:${lock.teeId}`,
				reason: `frozen recovered tee ${lock.teeId} for ${lock.badgeId} overruled by posterior selection`,
				// Say which one plainly. `tee-recovered-N` is named by its index
				// into G3's accepted-candidate list, so publishing N here means no
				// consumer has to parse it back out of an id or guess by position.
				values: {
					teeIndex: Number(/tee-recovered-(\d+)$/.exec(lock.teeId)?.[1] ?? -1),
					...(finite(lock.hole) ? { hole: lock.hole } : {})
				}
			});
		}
	}
	const isSuperseded = (tee: RecoveredTeeInput) =>
		superseded.some(
			(point) => Math.abs(point.x - tee.xPx) < 0.5 && Math.abs(point.y - tee.yPx) < 0.5
		);

	const existing = board
		.get<readonly RecoveredTeeInput[]>('recoveredTees')
		.filter((tee) => !isSuperseded(tee));
	const retired = board.get<readonly RecoveredTeeInput[]>('recoveredTees').length - existing.length;
	const additions: RecoveredTeeInput[] = [];

	for (const selection of evidence.jointTop[0]?.selections ?? []) {
		if (selection.kind !== 'candidate') continue;
		const hole = selection.hole ?? 'UNKNOWN';
		additions.push({
			xPx: selection.centerXPx,
			yPx: selection.centerYPx,
			score: selection.posteriorWithinTarget ?? 0,
			provenance: {
				source: 'tee-shard-recovery',
				note: `posterior-selected shard ${selection.id} for hole ${hole}: ${selection.supportPixels}px support, ${selection.unexplainedPixels}px unexplained, ${selection.distancePx.toFixed(1)}px from badge`,
				...(selection.posteriorWithinTarget === undefined
					? {}
					: { score: selection.posteriorWithinTarget })
			}
		});
		// The endpoint is not complete until something OWNS it. teeBadgeLock has
		// already run by now and will not re-lock, so a badge it abstained on
		// would end up with a tee and no lock -- 18 tees but 17 locks. Emit the
		// ownership edge here; featureRenders retires the lock this supersedes.
		const badge = badgeById.get(selection.badgeId);
		if (badge) {
			ctx.overlay(UNIT_ID, {
				type: 'polyline',
				path: [
					[badge.cxPx, badge.cyPx],
					[selection.centerXPx, selection.centerYPx]
				],
				verdict: 'accepted',
				visualRole: 'tee-badge-path',
				ref: `${FEATURE_ID}:ray:${encodeURIComponent(selection.badgeId)}:${encodeURIComponent(selection.id)}`,
				values: {
					...(finite(Number(selection.hole)) ? { hole: Number(selection.hole) } : {}),
					distancePx: selection.distancePx
				}
			});
		}
		ctx.overlay(UNIT_ID, {
			type: 'point',
			xPx: selection.centerXPx,
			yPx: selection.centerYPx,
			verdict: 'accepted',
			visualRole: 'tee-shard',
			ref: `${FEATURE_ID}:selected:${encodeURIComponent(selection.badgeId)}:${encodeURIComponent(selection.id)}`,
			values: {
				...(finite(Number(selection.hole)) ? { hole: Number(selection.hole) } : {}),
				posterior: selection.posteriorWithinTarget ?? 0,
				distancePx: selection.distancePx,
				supportPixels: selection.supportPixels,
				unexplainedPixels: selection.unexplainedPixels
			}
		});
	}

	for (const phantom of evidence.phantomProposals) {
		additions.push({ xPx: phantom.xPx, yPx: phantom.yPx, provenance: phantom.provenance });
		const phantomBadge = badgeById.get(phantom.badgeId);
		if (phantomBadge) {
			ctx.overlay(UNIT_ID, {
				type: 'polyline',
				path: [
					[phantomBadge.cxPx, phantomBadge.cyPx],
					[phantom.xPx, phantom.yPx]
				],
				verdict: 'accepted',
				visualRole: 'tee-badge-path',
				ref: `${FEATURE_ID}:ray:${encodeURIComponent(phantom.badgeId)}:hole-${phantom.hole}`,
				values: { hole: phantom.hole }
			});
		}
		ctx.overlay(UNIT_ID, {
			type: 'point',
			xPx: phantom.xPx,
			yPx: phantom.yPx,
			verdict: 'accepted',
			visualRole: 'phantom-center',
			ref: `${FEATURE_ID}:phantom:${encodeURIComponent(phantom.badgeId)}:hole-${phantom.hole}`,
			reason: phantom.provenance.note,
			values: { hole: phantom.hole }
		});
	}

	const recoveredTees = [...existing, ...additions];
	board.set('recoveredTees', recoveredTees);
	ctx.measure(UNIT_ID, 'posteriorRecoveredTeesPublished', additions.length);
	ctx.measure(UNIT_ID, 'posteriorRecoveredTeesRetired', retired);
	return { recoveredTees, supersededTeeIds };
}

/** Reattach the posterior's decisions to STABLE tee identity.
 *
 * `reassigned` is a full, independent rerun of `assignThreeFactor` over the
 * posterior's merged recoveredTees list. `assignThreeFactor` (and the
 * identical logic in exec/operations.ts's `assignment.pairs`) mints every
 * `tee-recovered-N` id by SORTED POSITION (y, x, provenance note) over
 * whichever recoveredTees array it is handed -- see assignment.ts's
 * `recoveredTee`. That numbering is only stable *within one call*: adding or
 * dropping any entry shifts the sorted index, and therefore the minted id,
 * of every OTHER recovered tee that sorts after it. c05521a's bug was
 * publishing `reassigned.tees` verbatim as the new `assignment.tees` --
 * silently renumbering tees for badges the posterior never reopened, so
 * frozen teeBadgeLock testimony (`tee-recovered-N`) started resolving to a
 * different physical tee for those badges (AlexClark H8/H10/H11 etc.).
 *
 * The fix: `preAssignment` (exactly what teeBadgeLock last saw) is the base
 * for every badge outside `evidence.targetBadgeIds` (C1) -- both its `tees`
 * and its `assignments` entries pass through with untouched identity. Only
 * `targets` (the posterior's actual candidate/phantom picks, C2) are pulled
 * from `reassigned`, matched back to `preAssignment.tees` by geometry so a
 * tee that already existed keeps its old id, and a genuinely new tee gets a
 * fresh id continuing past the highest existing `tee-recovered-N` index (the
 * scheme the receipt code already parses via `/tee-recovered-(\d+)$/`, so a
 * distinct namespace would need a second parser -- continuing the same
 * counter does not). `supersededTeeIds` drops the frozen recovered tees the
 * posterior is overruling from that base, mirroring what `recoveredTees`
 * (the RecoveredTeeInput board slot) already does.
 */
function commitPosteriorAssignments(
	preAssignment: ThreeFactorAssignment,
	reassigned: ThreeFactorAssignment,
	evidence: PosteriorTeeRecoveryEvidence,
	supersededTeeIds: ReadonlySet<string>
): ThreeFactorAssignment {
	const targets = [
		...(evidence.jointTop[0]?.selections ?? []).flatMap((selection) =>
			selection.kind === 'candidate'
				? [{ badgeId: selection.badgeId, xPx: selection.centerXPx, yPx: selection.centerYPx }]
				: []
		),
		...evidence.phantomProposals.map((phantom) => ({
			badgeId: phantom.badgeId,
			xPx: phantom.xPx,
			yPx: phantom.yPx
		}))
	];
	if (targets.length === 0) {
		return supersededTeeIds.size === 0
			? preAssignment
			: { ...preAssignment, tees: preAssignment.tees.filter((tee) => !supersededTeeIds.has(tee.detId)) };
	}

	let nextNewIndex =
		Math.max(
			-1,
			...preAssignment.tees.map((tee) => Number(/^tee-recovered-(\d+)$/.exec(tee.detId)?.[1] ?? -1))
		) + 1;
	const stableByGeometry = new Map(preAssignment.tees.map((tee) => [`${tee.xPx}:${tee.yPx}`, tee]));
	const newTees: TeeEvidence[] = [];

	const committed: AssignmentEvidence[] = [];
	const targetBadgeIds = new Set(targets.map((target) => target.badgeId));
	const committedTeeIds = new Set<string>();
	for (const target of targets) {
		const reassignedTee = reassigned.tees.find(
			(candidate) =>
				Math.abs(candidate.xPx - target.xPx) <= 0.5 && Math.abs(candidate.yPx - target.yPx) <= 0.5
		);
		if (!reassignedTee)
			throw new Error(`posterior assignment: published tee missing for ${target.badgeId}`);
		const geometryKey = `${reassignedTee.xPx}:${reassignedTee.yPx}`;
		let stableTee = stableByGeometry.get(geometryKey);
		if (!stableTee) {
			stableTee = { ...reassignedTee, detId: `tee-recovered-${nextNewIndex++}` };
			stableByGeometry.set(geometryKey, stableTee);
			newTees.push(stableTee);
		}
		committedTeeIds.add(stableTee.detId);
		const ranked = reassigned.scoredPairs
			.filter(
				(pair) => pair.raw.badgeId === target.badgeId && pair.raw.teeId === reassignedTee.detId
			)
			.sort((a, b) => b.score - a.score || a.raw.basketId.localeCompare(b.raw.basketId));
		const selected = ranked[0];
		if (!selected) {
			throw new Error(
				`posterior assignment: no routed pair carries ${target.badgeId} -> ${reassignedTee.detId}`
			);
		}
		committed.push({
			badgeId: target.badgeId,
			teeId: stableTee.detId,
			basketId: selected.raw.basketId,
			score: selected.score,
			rank: selected.rank,
			ownership: 'selected',
			alternatives: ranked.slice(1, 4).map((pair) => ({
				teeId: pair.raw.teeId,
				basketId: pair.raw.basketId,
				score: pair.score
			}))
		});
	}

	return {
		...preAssignment,
		tees: [...preAssignment.tees.filter((tee) => !supersededTeeIds.has(tee.detId)), ...newTees],
		assignments: [
			...preAssignment.assignments.filter(
				(row) => !targetBadgeIds.has(row.badgeId) && !committedTeeIds.has(row.teeId)
			),
			...committed
		].sort((a, b) => a.badgeId.localeCompare(b.badgeId))
	};
}

function executePosteriorTeeRecovery(board: ExecBoard, ctx: FeatureContext): void {
	const stop = ctx.span(UNIT_ID);
	const state = ctx.resolve(posteriorTeeRecoveryFeature);
	const evidence = state.enabled
		? inferPosterior(board, ctx, state.knobs as unknown as PosteriorKnobs)
		: disabledEvidence(false);
	if (state.enabled) {
		// Snapshot exactly what teeBadgeLock (and every frozen lock) last saw,
		// before this feature changes anything -- the base every untouched
		// badge is preserved from (C1; see commitPosteriorAssignments).
		const preAssignment = board.get<ThreeFactorAssignment>('assignment');
		const { recoveredTees, supersededTeeIds } = publishRecoveredTees(
			board,
			ctx,
			evidence,
			board.get<readonly BadgeEvidence[]>('badges')
		);
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		// Still a full recompute over the merged recoveredTees list -- routing
		// and scoring for the posterior's own picks need it -- but its ids are
		// used only to source geometry/scoring for reopened badges, never
		// published verbatim; see commitPosteriorAssignments for why.
		const reassigned = assignThreeFactor(
			measurement,
			recoveredTees,
			ctx.resolve(zfitFeature).knobs as unknown as ZfitKnobs,
			ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs,
			ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs,
			ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs,
			ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs
		);
		const assignment = commitPosteriorAssignments(
			preAssignment,
			reassigned,
			evidence,
			supersededTeeIds
		);
		board.set('assignment', assignment);
		board.set('assignment.tees', assignment.tees);
		board.set(
			'assignment.rawPairs',
			assignment.scoredPairs.map((pair) => pair.raw)
		);
	}
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
			'teeBadgeLock',
			'recoveredTees'
		],
		produces: [FEATURE_ID, 'recoveredTees', 'assignment', 'assignment.tees', 'assignment.rawPairs'],
		features: [FEATURE_ID],
		note: 'posterior reconciliation over the evidence-derived tee-recovery conflict island; commits each selected tee to its chosen badge'
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
	note: 'Posterior tee recovery: jointly rank shard/NULL hypotheses using course-local evidence models, then publish the selected hypotheses as real recovered tees.',
	render: POSTERIOR_TEE_RECOVERY_RENDER,
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
