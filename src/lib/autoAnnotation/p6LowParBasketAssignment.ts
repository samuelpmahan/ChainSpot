/**
 * Pancake 6: local LowPar basket assignment.
 *
 * P5 owns tee -> hole identity. P6 only scores candidate baskets against the
 * trusted tee, trusted badge, and candidate basket, then arbitrates the
 * remaining baskets one-to-one. The score is the existing LowPar
 * lightness-evidence line score: higher is better.
 */

import type { SourcePoint } from '../domain/annotatedRound';
import {
	buildClassicCorridorEvidence,
	DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS
} from './corridorBendDetectionCapsule';
import type { CorridorBendRaster } from './corridorBendDetection';
import { toEvidenceGridLocal } from './corridorEvidenceGrid';
import type { CorridorEvidenceGrid } from './corridorEvidenceGrid';
import type { P4HoleRibbonResult, P4RibbonOwnershipResult } from './p4RibbonOwnership';
import type { P2LabeledBadge } from './rawObjectOwnership';
import type { RawMaskBasket, RawMaskTee } from './rawObjectMask';
import type { P5SparseAssignmentResult, P5TeeAssignment } from './p5SparseAssignment';
import { DEFAULT_RIBBON_MASS_PARAMS, nearestComponentLabel, nearestKeptDistancePx } from './ribbonMass';
import type { RibbonMassParams, RibbonMassSegmentation } from './ribbonMass';
import { evaluateZeroBendBadgeOnChord } from './zeroBendChord';
import type { ZeroBendMaxDistancePx } from './visionFlags';

export const P6_DISALLOWED_COST = 1_000_000;
export const LOW_PAR_HIGHER_IS_BETTER = true;

/**
 * Pancake 6.2: conservative local 2-hole / 2-basket swap correction.
 *
 * P6.1's global Hungarian LowPar solve occasionally prefers a slightly
 * straighter cross-pair over the correct assignment on a locally-ambiguous
 * pair of holes. This stage never touches the Hungarian matrix or LowPar
 * scoring itself; it only inspects the already-gated P6.1 result for pairs
 * of LowPar-assigned holes whose baskets could swap, and swaps them when the
 * existing badge-associated ribbon-component evidence conservatively and
 * decisively favors the alternate permutation.
 */
export const MIN_RIBBON_IMPROVEMENT_PX = 20;

const LOW_PAR_LINE_SAMPLE_STEP_SRC_PX = 2 * 3;
const LOW_PAR_TRIM_FRACTION = 0.2;
const LOW_PAR_LENGTH_PENALTY_ALPHA = 0.2;
const LOW_PAR_MIN_SAMPLE_COUNT = 5;
const LOW_PAR_BADGE_MASK_HALF_WIDTH_SRC_PX = 34;
const LOW_PAR_BADGE_MASK_HALF_HEIGHT_SRC_PX = 24;
export const P6_FORWARD_GATE_ANGLE_DEG = 80;

export interface P6LowParOptions {
	/** Prestaging-only switch for the badge-on-chord shortcut. */
	readonly zeroBendShortcutEnabled?: boolean;
	/** Prestaging comparison between the measured 3px and 4px thresholds. */
	readonly zeroBendMaxDistancePx?: ZeroBendMaxDistancePx;
}

export interface P6BasketCandidate {
	readonly holeNumber: number;
	readonly basketIndex: number;
	readonly forwardProjectionPx: number;
	readonly forwardAngleDeg: number;
	readonly passedForwardGate: boolean;
	readonly lowParScore: number | null;
	readonly valid: boolean;
	readonly rankWithinHole: number;
}

export type P6BasketAssignmentStatus = 'p4Locked' | 'zeroBendLocked' | 'lowParAssigned' | 'unresolved';
export type P6BasketAssignmentReason = 'p4Locked' | 'zeroBendLocked' | 'lowPar' | 'noValidAssignment';

export interface P6BasketAssignment {
	readonly holeNumber: number;
	readonly teeIndex: number | null;
	readonly p4BasketStatus: P4HoleRibbonResult['status'] | 'unresolved';
	readonly p4BasketIndex: number | null;
	readonly candidateBasketCount: number;
	readonly candidatesBeforeGate: number;
	readonly candidatesAfterGate: number;
	readonly gateFallbackUsed: boolean;
	readonly assignedBasketIndex: number | null;
	readonly assignedForwardAngleDeg: number | null;
	readonly assignmentReason: P6BasketAssignmentReason;
	readonly lowParScore: number | null;
	readonly status: P6BasketAssignmentStatus;
}

export interface P6LowParBasketAssignmentSnapshot {
	readonly assignments: readonly P6BasketAssignment[];
	readonly candidates: readonly P6BasketCandidate[];
	readonly lockedByP4: number;
	readonly lockedByZeroBend: number;
	readonly assignedByLowPar: number;
	readonly unresolved: number;
	readonly duplicateBaskets: readonly number[];
	readonly disallowedAssignmentsRejected: number;
	readonly totalAssignmentCost: number;
	readonly lowParHigherIsBetter: boolean;
	readonly forwardGateAngleDeg: number | null;
	readonly candidatesBeforeGate: number;
	readonly candidatesAfterGate: number;
	readonly gateFallbackHoles: number;
}

export interface P6LowParBasketAssignmentResult extends P6LowParBasketAssignmentSnapshot {
	/** The unchanged ungated P6 result retained for the P6.1 comparison. */
	readonly originalP6?: P6LowParBasketAssignmentSnapshot;
	readonly changedHoleNumbers?: readonly number[];
	/** Pancake-6.2 local ribbon-evidence swap adjudication over the P6.1 gated assignment. */
	readonly swapAdjudication?: P6SwapAdjudicationResult;
}

/** One considered 2-hole / 2-basket swap: hole A/B currently own basket X/Y respectively. */
export interface P6SwapPairDiagnostic {
	readonly holeA: number;
	readonly holeB: number;
	readonly basketX: number;
	readonly basketY: number;
	readonly lowParAX: number | null;
	readonly lowParAY: number | null;
	readonly lowParBX: number | null;
	readonly lowParBY: number | null;
	readonly ribbonAX: number | null;
	readonly ribbonAY: number | null;
	readonly ribbonBX: number | null;
	readonly ribbonBY: number | null;
	readonly currentRibbonCost: number | null;
	readonly swappedRibbonCost: number | null;
	readonly ribbonImprovementPx: number | null;
	readonly swapApplied: boolean;
}

export interface P6SwapAdjudicationResult {
	readonly pairsConsidered: number;
	readonly swapsApplied: number;
	readonly changedHoleNumbers: readonly number[];
	readonly ms: number;
	readonly pairs: readonly P6SwapPairDiagnostic[];
}

function sampleAlongPolyline(points: readonly SourcePoint[], stepPx: number): SourcePoint[] {
	const samples: SourcePoint[] = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		const segmentLength = Math.hypot(end.xPx - start.xPx, end.yPx - start.yPx);
		const count = Math.max(2, Math.floor(segmentLength / stepPx));
		for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
			const t = sampleIndex / count;
			samples.push({
				xPx: start.xPx + (end.xPx - start.xPx) * t,
				yPx: start.yPx + (end.yPx - start.yPx) * t
			});
		}
	}
	samples.push(points[points.length - 1]);
	return samples;
}

function polylineLength(points: readonly SourcePoint[]): number {
	let total = 0;
	for (let index = 1; index < points.length; index += 1) {
		total += Math.hypot(points[index].xPx - points[index - 1].xPx, points[index].yPx - points[index - 1].yPx);
	}
	return total;
}

function lowParLineScore(
	evidence: Float32Array,
	widthPx: number,
	heightPx: number,
	points: readonly SourcePoint[],
	badge: SourcePoint,
	gridScale: number
): number | null {
	const samples = sampleAlongPolyline(points, LOW_PAR_LINE_SAMPLE_STEP_SRC_PX / gridScale);
	const values: number[] = [];
	const halfWidth = LOW_PAR_BADGE_MASK_HALF_WIDTH_SRC_PX / gridScale;
	const halfHeight = LOW_PAR_BADGE_MASK_HALF_HEIGHT_SRC_PX / gridScale;
	for (const sample of samples) {
		if (
			sample.xPx >= badge.xPx - halfWidth &&
			sample.xPx <= badge.xPx + halfWidth &&
			sample.yPx >= badge.yPx - halfHeight &&
			sample.yPx <= badge.yPx + halfHeight
		) {
			continue;
		}
		const x = Math.min(widthPx - 1, Math.max(0, Math.floor(sample.xPx)));
		const y = Math.min(heightPx - 1, Math.max(0, Math.floor(sample.yPx)));
		values.push(evidence[y * widthPx + x]);
	}
	if (values.length < LOW_PAR_MIN_SAMPLE_COUNT) return null;
	values.sort((a, b) => a - b);
	const kept = values.slice(Math.floor(LOW_PAR_TRIM_FRACTION * values.length));
	const mean = kept.reduce((total, value) => total + value, 0) / kept.length;
	const straightLength = Math.max(
		Math.hypot(points[points.length - 1].xPx - points[0].xPx, points[points.length - 1].yPx - points[0].yPx),
		1e-6
	);
	const excessLengthPenalty =
		LOW_PAR_LENGTH_PENALTY_ALPHA * Math.max(0, polylineLength(points) / straightLength - 1);
	return mean - excessLengthPenalty;
}

/**
 * Scores one trusted tee -> trusted badge -> candidate basket path using the
 * existing LowPar line-score semantics. Higher scores are better. `null` is
 * the existing scorer's explicit invalid/unscorable result.
 */
export function scoreLowParBasketCandidate(
	evidenceGrid: CorridorEvidenceGrid,
	tee: SourcePoint,
	badge: SourcePoint,
	basket: SourcePoint
): number | null {
	const teeLocal = toEvidenceGridLocal(evidenceGrid, tee);
	const badgeLocal = toEvidenceGridLocal(evidenceGrid, badge);
	const basketLocal = toEvidenceGridLocal(evidenceGrid, basket);
	return lowParLineScore(
		evidenceGrid.evidence,
		evidenceGrid.widthPx,
		evidenceGrid.heightPx,
		[
			teeLocal,
			badgeLocal,
			basketLocal
		],
		badgeLocal,
		evidenceGrid.scale
	);
}

/** Local copy of P5's existing minimum-cost Hungarian routine. */
function hungarian(cost: readonly (readonly number[])[]): number[] {
	const rowCount = cost.length;
	if (rowCount === 0) return [];
	const columnCount = cost[0]?.length ?? 0;
	if (columnCount < rowCount) throw new Error('P6 Hungarian assignment requires at least as many columns as rows.');
	if (cost.some((row) => row.length !== columnCount)) throw new Error('P6 Hungarian assignment received a ragged cost matrix.');

	const u = new Array<number>(rowCount + 1).fill(0);
	const v = new Array<number>(columnCount + 1).fill(0);
	const p = new Array<number>(columnCount + 1).fill(0);
	const way = new Array<number>(columnCount + 1).fill(0);

	for (let row = 1; row <= rowCount; row += 1) {
		p[0] = row;
		let column0 = 0;
		const minValue = new Array<number>(columnCount + 1).fill(Number.POSITIVE_INFINITY);
		const used = new Array<boolean>(columnCount + 1).fill(false);
		do {
			used[column0] = true;
			const row0 = p[column0];
			let delta = Number.POSITIVE_INFINITY;
			let column1 = 0;
			for (let column = 1; column <= columnCount; column += 1) {
				if (used[column]) continue;
				const reducedCost = cost[row0 - 1][column - 1] - u[row0] - v[column];
				if (reducedCost < minValue[column]) {
					minValue[column] = reducedCost;
					way[column] = column0;
				}
				if (minValue[column] < delta) {
					delta = minValue[column];
					column1 = column;
				}
			}
			for (let column = 0; column <= columnCount; column += 1) {
				if (used[column]) {
					u[p[column]] += delta;
					v[column] -= delta;
				} else {
					minValue[column] -= delta;
				}
			}
			column0 = column1;
		} while (p[column0] !== 0);

		do {
			const column1 = way[column0];
			p[column0] = p[column1];
			column0 = column1;
		} while (column0 !== 0);
	}

	const assignment = new Array<number>(rowCount).fill(-1);
	for (let column = 1; column <= columnCount; column += 1) {
		if (p[column] !== 0) assignment[p[column] - 1] = column - 1;
	}
	return assignment;
}

function p4HoleByNumber(p4: P4RibbonOwnershipResult): Map<number, P4HoleRibbonResult> {
	return new Map(p4.holes.map((hole) => [hole.holeNumber, hole]));
}

function p5AssignmentByHole(p5: P5SparseAssignmentResult): Map<number, P5TeeAssignment> {
	return new Map(
		p5.assignments
			.filter((assignment): assignment is P5TeeAssignment & { readonly assignedHoleNumber: number } =>
				assignment.assignedHoleNumber !== null
			)
			.map((assignment) => [assignment.assignedHoleNumber, assignment])
	);
}

/**
 * Pancake 6's pre-ribbon-evidence 0-bend badge-on-chord shortcut: a lock
 * pass parallel to and computed alongside `p4Locks`, BEFORE `evidenceGrid`/
 * `scoreLowParBasketCandidate` is ever built or called for any hole.
 *
 * For each hole with a P5-assigned tee and a P2-labeled badge that is NOT
 * already locked by P4, checks every basket not already excluded by P4 with
 * `evaluateZeroBendBadgeOnChord`. Locks are accepted only for one-to-one
 * edges: the hole has exactly one qualifying basket AND that basket qualifies
 * for exactly one hole. Shared baskets and multi-basket holes are ambiguity,
 * so every involved hole and basket falls through unchanged to the existing
 * ribbon-evidence LowPar/Hungarian path.
 *
 * Pure aside from its inputs: exported standalone so the lock-selection
 * behavior (exactly one candidate locks; zero or multiple candidates don't)
 * can be unit-tested directly, without constructing a CorridorBendRaster or
 * running real ribbon segmentation.
 */
export function computeZeroBendLocks(
	tees: readonly RawMaskTee[],
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	p5: P5SparseAssignmentResult,
	alreadyLockedHoleNumbers: ReadonlySet<number>,
	alreadyLockedBasketIndexes: ReadonlySet<number>,
	options: P6LowParOptions = {}
): Map<number, number> {
	if (options.zeroBendShortcutEnabled === false) return new Map();
	const p5ByHole = p5AssignmentByHole(p5);
	const badgesByHole = new Map(badges.map((badge) => [badge.holeNumber, badge]));
	const holeNumbers = Array.from(new Set([...badgesByHole.keys(), ...p5ByHole.keys()])).sort((a, b) => a - b);

	const candidateBasketIndexesByHole = new Map<number, number[]>();
	const candidateHoleCountByBasket = new Map<number, number>();
	for (const holeNumber of holeNumbers) {
		if (alreadyLockedHoleNumbers.has(holeNumber)) continue;
		const assignment = p5ByHole.get(holeNumber);
		const tee = assignment ? tees[assignment.teeIndex] : undefined;
		const badge = badgesByHole.get(holeNumber);
		if (!tee || !badge) continue;

		const onChordBasketIndexes: number[] = [];
		for (let basketIndex = 0; basketIndex < baskets.length; basketIndex += 1) {
			if (alreadyLockedBasketIndexes.has(basketIndex)) continue;
			const basket = baskets[basketIndex];
			const evaluation = evaluateZeroBendBadgeOnChord(
				{ xPx: tee.xPx, yPx: tee.yPx },
				{ xPx: basket.centerXPx, yPx: basket.centerYPx },
				{ xPx: badge.xPx, yPx: badge.yPx },
				{ maxDistancePx: options.zeroBendMaxDistancePx }
			);
			if (evaluation.onChord) onChordBasketIndexes.push(basketIndex);
		}
		candidateBasketIndexesByHole.set(holeNumber, onChordBasketIndexes);
		for (const basketIndex of onChordBasketIndexes) {
			candidateHoleCountByBasket.set(
				basketIndex,
				(candidateHoleCountByBasket.get(basketIndex) ?? 0) + 1
			);
		}
	}

	const zeroBendLocks = new Map<number, number>();
	for (const [holeNumber, basketIndexes] of candidateBasketIndexesByHole) {
		if (basketIndexes.length !== 1) continue;
		const basketIndex = basketIndexes[0];
		if (candidateHoleCountByBasket.get(basketIndex) === 1) {
			zeroBendLocks.set(holeNumber, basketIndex);
		}
	}
	return zeroBendLocks;
}

/**
 * `basket` takes the same point the caller scores the candidate against
 * (bbox center), not a `RawMaskBasket` -- a basket has more than one Y
 * reference (see `rawObjectMask.ts`'s `yPx` vs `centerYPx`), and this gate
 * must never be free to pick a different one than the ranking score did.
 */
export function forwardGateForBasket(
	tee: SourcePoint,
	badge: SourcePoint,
	basket: SourcePoint
): Pick<P6BasketCandidate, 'forwardProjectionPx' | 'forwardAngleDeg' | 'passedForwardGate'> {
	const teeToBadgeX = badge.xPx - tee.xPx;
	const teeToBadgeY = badge.yPx - tee.yPx;
	const teeToBadgeLength = Math.hypot(teeToBadgeX, teeToBadgeY);
	const forwardX = teeToBadgeLength > 0 ? teeToBadgeX / teeToBadgeLength : 0;
	const forwardY = teeToBadgeLength > 0 ? teeToBadgeY / teeToBadgeLength : 0;
	const badgeToBasketX = basket.xPx - badge.xPx;
	const badgeToBasketY = basket.yPx - badge.yPx;
	const forwardProjectionPx = badgeToBasketX * forwardX + badgeToBasketY * forwardY;
	const lateralOffsetPx = Math.abs(badgeToBasketX * forwardY - badgeToBasketY * forwardX);
	const forwardAngleDeg = (Math.atan2(lateralOffsetPx, forwardProjectionPx) * 180) / Math.PI;

	return {
		forwardProjectionPx,
		forwardAngleDeg,
		passedForwardGate: forwardProjectionPx > 0 && forwardAngleDeg <= P6_FORWARD_GATE_ANGLE_DEG
	};
}

function isHardP4BasketLock(hole: P4HoleRibbonResult, sharedComponents: ReadonlySet<number>): boolean {
	return (
		hole.status === 'basketResolved' &&
		hole.basketIndexes.length === 1 &&
		hole.ribbonComponentLabel !== undefined &&
		!sharedComponents.has(hole.ribbonComponentLabel)
	);
}

function sortCandidates(candidates: readonly P6BasketCandidate[]): P6BasketCandidate[] {
	return [...candidates]
		.sort((a, b) => {
			if (a.valid !== b.valid) return a.valid ? -1 : 1;
			if (a.lowParScore === null && b.lowParScore === null) return a.basketIndex - b.basketIndex;
			if (a.lowParScore === null) return 1;
			if (b.lowParScore === null) return -1;
			return b.lowParScore - a.lowParScore || a.basketIndex - b.basketIndex;
		})
		.map((candidate, index) => ({ ...candidate, rankWithinHole: index + 1 }));
}

function deriveP6LowParBasketAssignmentSnapshot(
	raster: CorridorBendRaster,
	tees: readonly RawMaskTee[],
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	p5: P5SparseAssignmentResult,
	p4: P4RibbonOwnershipResult,
	useForwardGate: boolean,
	options: P6LowParOptions
): P6LowParBasketAssignmentSnapshot {
	const p4ByHole = p4HoleByNumber(p4);
	const p5ByHole = p5AssignmentByHole(p5);
	const sharedComponents = new Set(p4.sharedComponentLabels);
	const p4Locks = new Map<number, number>();
	for (const hole of p4.holes) {
		if (isHardP4BasketLock(hole, sharedComponents)) p4Locks.set(hole.holeNumber, hole.basketIndexes[0]);
	}
	// 0-bend badge-on-chord shortcut (see computeZeroBendLocks doc comment):
	// computed alongside p4Locks, before evidenceGrid/scoreLowParBasketCandidate
	// exist for any hole. p4Locks always wins -- holes/baskets it already
	// claimed are excluded here and never reconsidered.
	const zeroBendLocks = computeZeroBendLocks(
		tees,
		baskets,
		badges,
		p5,
		new Set(p4Locks.keys()),
		new Set(p4Locks.values()),
		options
	);
	const lockedBasketIndexes = new Set([...p4Locks.values(), ...zeroBendLocks.values()]);
	const unlockedBasketIndexes = baskets
		.map((_, basketIndex) => basketIndex)
		.filter((basketIndex) => !lockedBasketIndexes.has(basketIndex));
	const badgesByHole = new Map(badges.map((badge) => [badge.holeNumber, badge]));
	const holeNumbers = Array.from(new Set([...badgesByHole.keys(), ...p5ByHole.keys()])).sort((a, b) => a - b);

	const trustedPairs = holeNumbers.flatMap((holeNumber) => {
		const assignment = p5ByHole.get(holeNumber);
		const tee = assignment ? tees[assignment.teeIndex] : undefined;
		const badge = badgesByHole.get(holeNumber);
		return tee && badge ? [{ tee, badge }] : [];
	});
	const evidenceGrid = trustedPairs[0] && baskets[0]
		? buildClassicCorridorEvidence(raster, trustedPairs[0].tee, baskets[0], DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS)
		: null;

	const candidatesByHole = new Map<number, P6BasketCandidate[]>();
	const solveCandidatesByHole = new Map<number, P6BasketCandidate[]>();
	const gateStatsByHole = new Map<number, {
		readonly candidatesBeforeGate: number;
		readonly candidatesAfterGate: number;
		readonly gateFallbackUsed: boolean;
	}>();
	let candidatesBeforeGate = 0;
	let candidatesAfterGate = 0;
	let gateFallbackHoles = 0;
	for (const holeNumber of holeNumbers) {
		if (p4Locks.has(holeNumber) || zeroBendLocks.has(holeNumber)) continue;
		const assignment = p5ByHole.get(holeNumber);
		const tee = assignment ? tees[assignment.teeIndex] : undefined;
		const badge = badgesByHole.get(holeNumber);
		if (!tee || !badge || !evidenceGrid) {
			candidatesByHole.set(holeNumber, []);
			continue;
		}
		const rankedCandidates = sortCandidates(
			unlockedBasketIndexes.map((basketIndex): P6BasketCandidate => {
				const basket = baskets[basketIndex];
				const basketPoint = { xPx: basket.centerXPx, yPx: basket.centerYPx };
				const lowParScore = scoreLowParBasketCandidate(
					evidenceGrid,
					{ xPx: tee.xPx, yPx: tee.yPx },
					{ xPx: badge.xPx, yPx: badge.yPx },
					basketPoint
				);
				return {
					holeNumber,
					basketIndex,
					...forwardGateForBasket(
						{ xPx: tee.xPx, yPx: tee.yPx },
						{ xPx: badge.xPx, yPx: badge.yPx },
						basketPoint
					),
					lowParScore,
					valid: lowParScore !== null && Number.isFinite(lowParScore),
					rankWithinHole: 0
				};
			})
		);
		const passedForwardGate = rankedCandidates.filter((candidate) => candidate.passedForwardGate);
		const gateFallbackUsed = useForwardGate && passedForwardGate.length === 0;
		const solveCandidates = !useForwardGate || gateFallbackUsed ? rankedCandidates : passedForwardGate;
		candidatesByHole.set(holeNumber, rankedCandidates);
		solveCandidatesByHole.set(holeNumber, solveCandidates);
		gateStatsByHole.set(holeNumber, {
			candidatesBeforeGate: rankedCandidates.length,
			candidatesAfterGate: useForwardGate ? passedForwardGate.length : rankedCandidates.length,
			gateFallbackUsed
		});
		candidatesBeforeGate += rankedCandidates.length;
		candidatesAfterGate += useForwardGate ? passedForwardGate.length : rankedCandidates.length;
		if (gateFallbackUsed) gateFallbackHoles += 1;
	}

	const solveRows = holeNumbers.filter(
		(holeNumber) => !p4Locks.has(holeNumber) && !zeroBendLocks.has(holeNumber) && candidatesByHole.has(holeNumber)
	);
	const columnCount = Math.max(solveRows.length, unlockedBasketIndexes.length);
	const columns: readonly (number | null)[] = [
		...unlockedBasketIndexes,
		...new Array<number | null>(columnCount - unlockedBasketIndexes.length).fill(null)
	];
	const candidateByHoleAndBasket = new Map(
		Array.from(solveCandidatesByHole.entries()).map(([holeNumber, candidates]) => [
			holeNumber,
			new Map(candidates.map((candidate) => [candidate.basketIndex, candidate]))
		])
	);
	const matrix = solveRows.map((holeNumber) =>
		columns.map((basketIndex) => {
			if (basketIndex === null) return P6_DISALLOWED_COST;
			const candidate = candidateByHoleAndBasket.get(holeNumber)?.get(basketIndex);
			if (!candidate?.valid || candidate.lowParScore === null) return P6_DISALLOWED_COST;
			return LOW_PAR_HIGHER_IS_BETTER ? -candidate.lowParScore : candidate.lowParScore;
		})
	);
	const solverAssignments = hungarian(matrix);
	let disallowedAssignmentsRejected = 0;
	const assignedByHole = new Map<number, {
		basketIndex: number;
		lowParScore: number;
		forwardAngleDeg: number;
	}>();
	for (const [rowIndex, holeNumber] of solveRows.entries()) {
		const columnIndex = solverAssignments[rowIndex] ?? -1;
		const basketIndex = columnIndex < 0 ? null : columns[columnIndex] ?? null;
		const candidate = basketIndex === null ? undefined : candidateByHoleAndBasket.get(holeNumber)?.get(basketIndex);
		const cost = columnIndex < 0 ? P6_DISALLOWED_COST : matrix[rowIndex][columnIndex];
		if (
			basketIndex !== null &&
			unlockedBasketIndexes.includes(basketIndex) &&
			candidate?.valid === true &&
			candidate.lowParScore !== null &&
			cost !== P6_DISALLOWED_COST
		) {
			assignedByHole.set(holeNumber, {
				basketIndex,
				lowParScore: candidate.lowParScore,
				forwardAngleDeg: candidate.forwardAngleDeg
			});
		} else {
			disallowedAssignmentsRejected += 1;
		}
	}

	const ownersByBasket = new Map<number, number[]>();
	for (const [holeNumber, basketIndex] of p4Locks) {
		const owners = ownersByBasket.get(basketIndex) ?? [];
		owners.push(holeNumber);
		ownersByBasket.set(basketIndex, owners);
	}
	for (const [holeNumber, basketIndex] of zeroBendLocks) {
		const owners = ownersByBasket.get(basketIndex) ?? [];
		owners.push(holeNumber);
		ownersByBasket.set(basketIndex, owners);
	}
	for (const [holeNumber, assignment] of assignedByHole) {
		const owners = ownersByBasket.get(assignment.basketIndex) ?? [];
		owners.push(holeNumber);
		ownersByBasket.set(assignment.basketIndex, owners);
	}
	const duplicateBaskets = Array.from(ownersByBasket.entries())
		.filter(([, owners]) => owners.length > 1)
		.map(([basketIndex]) => basketIndex);
	const duplicateRows = new Set(
		duplicateBaskets.flatMap((basketIndex) => ownersByBasket.get(basketIndex) ?? [])
	);
	for (const holeNumber of duplicateRows) assignedByHole.delete(holeNumber);

	const assignments = holeNumbers.map((holeNumber): P6BasketAssignment => {
		const p4Hole = p4ByHole.get(holeNumber);
		const p4BasketIndex = p4Locks.get(holeNumber) ?? null;
		const zeroBendBasketIndex = zeroBendLocks.get(holeNumber) ?? null;
		const p5Assignment = p5ByHole.get(holeNumber);
		const lowParAssignment = assignedByHole.get(holeNumber);
		const gateStats = gateStatsByHole.get(holeNumber);
		if (p4BasketIndex !== null && !duplicateRows.has(holeNumber)) {
			return {
				holeNumber,
				teeIndex: p5Assignment?.teeIndex ?? p4Hole?.teeIndex ?? null,
				p4BasketStatus: p4Hole?.status ?? 'unresolved',
				p4BasketIndex,
				candidateBasketCount: 0,
				candidatesBeforeGate: 0,
				candidatesAfterGate: 0,
				gateFallbackUsed: false,
				assignedBasketIndex: p4BasketIndex,
				assignedForwardAngleDeg: null,
				assignmentReason: 'p4Locked',
				lowParScore: null,
				status: 'p4Locked'
			};
		}
		if (zeroBendBasketIndex !== null && !duplicateRows.has(holeNumber)) {
			return {
				holeNumber,
				teeIndex: p5Assignment?.teeIndex ?? null,
				p4BasketStatus: p4Hole?.status ?? 'unresolved',
				p4BasketIndex,
				candidateBasketCount: 0,
				candidatesBeforeGate: 0,
				candidatesAfterGate: 0,
				gateFallbackUsed: false,
				assignedBasketIndex: zeroBendBasketIndex,
				assignedForwardAngleDeg: null,
				assignmentReason: 'zeroBendLocked',
				lowParScore: null,
				status: 'zeroBendLocked'
			};
		}
		if (lowParAssignment && !duplicateRows.has(holeNumber)) {
			return {
				holeNumber,
				teeIndex: p5Assignment?.teeIndex ?? null,
				p4BasketStatus: p4Hole?.status ?? 'unresolved',
				p4BasketIndex,
				candidateBasketCount: candidatesByHole.get(holeNumber)?.length ?? 0,
				candidatesBeforeGate: gateStats?.candidatesBeforeGate ?? 0,
				candidatesAfterGate: gateStats?.candidatesAfterGate ?? 0,
				gateFallbackUsed: gateStats?.gateFallbackUsed ?? false,
				assignedBasketIndex: lowParAssignment.basketIndex,
				assignedForwardAngleDeg: lowParAssignment.forwardAngleDeg,
				assignmentReason: 'lowPar',
				lowParScore: lowParAssignment.lowParScore,
				status: 'lowParAssigned'
			};
		}
		return {
			holeNumber,
			teeIndex: p5Assignment?.teeIndex ?? null,
			p4BasketStatus: p4Hole?.status ?? 'unresolved',
			p4BasketIndex,
			candidateBasketCount: candidatesByHole.get(holeNumber)?.length ?? 0,
			candidatesBeforeGate: gateStats?.candidatesBeforeGate ?? 0,
			candidatesAfterGate: gateStats?.candidatesAfterGate ?? 0,
			gateFallbackUsed: gateStats?.gateFallbackUsed ?? false,
			assignedBasketIndex: null,
			assignedForwardAngleDeg: null,
			assignmentReason: 'noValidAssignment',
			lowParScore: null,
			status: 'unresolved'
		};
	});

	return {
		assignments,
		candidates: Array.from(candidatesByHole.values()).flat(),
		lockedByP4: assignments.filter((assignment) => assignment.status === 'p4Locked').length,
		lockedByZeroBend: assignments.filter((assignment) => assignment.status === 'zeroBendLocked').length,
		assignedByLowPar: assignments.filter((assignment) => assignment.status === 'lowParAssigned').length,
		unresolved: assignments.filter((assignment) => assignment.status === 'unresolved').length,
		duplicateBaskets,
		disallowedAssignmentsRejected,
		totalAssignmentCost: Array.from(assignedByHole.values()).reduce(
			(total, assignment) => total + (LOW_PAR_HIGHER_IS_BETTER ? -assignment.lowParScore : assignment.lowParScore),
			0
		),
		lowParHigherIsBetter: LOW_PAR_HIGHER_IS_BETTER,
		forwardGateAngleDeg: useForwardGate ? P6_FORWARD_GATE_ANGLE_DEG : null,
		candidatesBeforeGate,
		candidatesAfterGate,
		gateFallbackHoles
	};
}

function changedP6HoleNumbers(
	originalP6: P6LowParBasketAssignmentSnapshot,
	gatedP6: P6LowParBasketAssignmentSnapshot
): number[] {
	const originalByHole = new Map(originalP6.assignments.map((assignment) => [assignment.holeNumber, assignment]));
	return gatedP6.assignments
		.filter((assignment) => {
			const original = originalByHole.get(assignment.holeNumber);
			return (
				original?.assignedBasketIndex !== assignment.assignedBasketIndex ||
				original?.status !== assignment.status
			);
		})
		.map((assignment) => assignment.holeNumber)
		.sort((left, right) => left - right);
}

/**
 * Finds every unordered pair of LowPar-assigned holes (A, B) whose current
 * baskets (X, Y) could swap: the alternate edges A->Y and B->X must already
 * exist as valid scored candidates in the P6.1 candidate pool (no new
 * candidate edges are created). P4-locked and unresolved holes never
 * participate.
 */
function findSwapCandidatePairs(
	gatedP6: P6LowParBasketAssignmentSnapshot
): readonly {
	readonly holeA: P6BasketAssignment & { readonly assignedBasketIndex: number; readonly lowParScore: number };
	readonly holeB: P6BasketAssignment & { readonly assignedBasketIndex: number; readonly lowParScore: number };
	readonly candidateAY: P6BasketCandidate;
	readonly candidateBX: P6BasketCandidate;
}[] {
	const lowParAssigned = gatedP6.assignments.filter(
		(
			assignment
		): assignment is P6BasketAssignment & { readonly assignedBasketIndex: number; readonly lowParScore: number } =>
			assignment.status === 'lowParAssigned' &&
			assignment.assignedBasketIndex !== null &&
			assignment.lowParScore !== null
	);
	const candidateByHoleAndBasket = new Map<string, P6BasketCandidate>();
	for (const candidate of gatedP6.candidates) {
		candidateByHoleAndBasket.set(`${candidate.holeNumber}:${candidate.basketIndex}`, candidate);
	}

	const pairs: {
		readonly holeA: P6BasketAssignment & { readonly assignedBasketIndex: number; readonly lowParScore: number };
		readonly holeB: P6BasketAssignment & { readonly assignedBasketIndex: number; readonly lowParScore: number };
		readonly candidateAY: P6BasketCandidate;
		readonly candidateBX: P6BasketCandidate;
	}[] = [];
	for (let indexA = 0; indexA < lowParAssigned.length; indexA += 1) {
		for (let indexB = indexA + 1; indexB < lowParAssigned.length; indexB += 1) {
			const holeA = lowParAssigned[indexA];
			const holeB = lowParAssigned[indexB];
			if (holeA.assignedBasketIndex === holeB.assignedBasketIndex) continue;
			const candidateAY = candidateByHoleAndBasket.get(`${holeA.holeNumber}:${holeB.assignedBasketIndex}`);
			const candidateBX = candidateByHoleAndBasket.get(`${holeB.holeNumber}:${holeA.assignedBasketIndex}`);
			if (!candidateAY?.valid || candidateAY.lowParScore === null) continue;
			if (!candidateBX?.valid || candidateBX.lowParScore === null) continue;
			pairs.push({ holeA, holeB, candidateAY, candidateBX });
		}
	}
	return pairs;
}

/**
 * Nearest source-pixel distance from a P1 basket anchor to a hole's
 * badge-associated ribbon component (P4's `nearestComponentLabel`/
 * `nearestKeptDistancePx` machinery, reused as-is). `null` when the badge
 * has no local ribbon component or the component has no reachable pixels —
 * the caller must skip the pair rather than guess.
 */
function ribbonComponentDistancePx(
	segmentation: RibbonMassSegmentation,
	componentLabel: number | null,
	basket: RawMaskBasket
): number | null {
	if (componentLabel === null) return null;
	const distancePx = nearestKeptDistancePx(
		segmentation.labels,
		segmentation.widthEv,
		segmentation.heightEv,
		segmentation.scale,
		new Set([componentLabel]),
		basket.centerXPx,
		basket.centerYPx
	);
	return Number.isFinite(distancePx) ? distancePx : null;
}

/**
 * Pancake 6.2: derives the conservative post-assignment 2-cycle correction.
 * Takes the SAME ribbon segmentation P4 used (built once by the caller and
 * shared across stages) rather than re-segmenting; this stage never
 * segments the raster itself.
 */
function derive2x2SwapAdjudication(
	gatedP6: P6LowParBasketAssignmentSnapshot,
	segmentation: RibbonMassSegmentation,
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	ribbonParams: RibbonMassParams = DEFAULT_RIBBON_MASS_PARAMS
): P6SwapAdjudicationResult {
	const startedAt = performance.now();
	const candidatePairs = findSwapCandidatePairs(gatedP6);
	if (candidatePairs.length === 0) {
		return { pairsConsidered: 0, swapsApplied: 0, changedHoleNumbers: [], ms: performance.now() - startedAt, pairs: [] };
	}

	const badgeByHole = new Map(badges.map((badge) => [badge.holeNumber, badge]));
	const ribbonComponentByHole = new Map<number, number | null>();
	const ribbonComponentForHole = (holeNumber: number): number | null => {
		const cached = ribbonComponentByHole.get(holeNumber);
		if (cached !== undefined) return cached;
		const badge = badgeByHole.get(holeNumber);
		const componentLabel = badge
			? nearestComponentLabel(
					segmentation.labels,
					segmentation.widthEv,
					segmentation.heightEv,
					segmentation.scale,
					badge.xPx,
					badge.yPx,
					ribbonParams.seedRadiusPx
				)
			: null;
		ribbonComponentByHole.set(holeNumber, componentLabel);
		return componentLabel;
	};

	// Compute every pair's ribbon-cost diagnostics up front (order-independent),
	// then decide which pairs actually swap in a SEPARATE pass ordered by
	// evidence strength (largest ribbonImprovementPx first) rather than by
	// enumeration order (ascending hole number). Enumeration order is
	// arbitrary with respect to evidence: on courses where a hole belongs to
	// more than one candidate pair, deciding by enumeration order lets a
	// weak, barely-qualifying swap permanently consume a hole before a much
	// stronger swap for that same hole is even evaluated -- including cases
	// where the weak swap sacrifices a hole whose current assignment was
	// already correct to "average out" a noisy partner. Ordering by
	// strongest-evidence-first instead lets the most decisive swaps claim
	// their holes first, which is what "conservative" is supposed to mean.
	interface PairEvaluation {
		readonly holeA: (typeof candidatePairs)[number]['holeA'];
		readonly holeB: (typeof candidatePairs)[number]['holeB'];
		readonly basketX: number;
		readonly basketY: number;
		readonly lowParAX: number | null;
		readonly lowParAY: number | null;
		readonly lowParBX: number | null;
		readonly lowParBY: number | null;
		readonly ribbonAX: number | null;
		readonly ribbonAY: number | null;
		readonly ribbonBX: number | null;
		readonly ribbonBY: number | null;
		readonly currentRibbonCost: number | null;
		readonly swappedRibbonCost: number | null;
		readonly ribbonImprovementPx: number | null;
		readonly eligible: boolean;
	}

	const evaluations: PairEvaluation[] = candidatePairs.map(({ holeA, holeB, candidateAY, candidateBX }) => {
		const basketX = holeA.assignedBasketIndex;
		const basketY = holeB.assignedBasketIndex;
		const componentA = ribbonComponentForHole(holeA.holeNumber);
		const componentB = ribbonComponentForHole(holeB.holeNumber);
		const ribbonAX = ribbonComponentDistancePx(segmentation, componentA, baskets[basketX]);
		const ribbonAY = ribbonComponentDistancePx(segmentation, componentA, baskets[basketY]);
		const ribbonBX = ribbonComponentDistancePx(segmentation, componentB, baskets[basketX]);
		const ribbonBY = ribbonComponentDistancePx(segmentation, componentB, baskets[basketY]);
		const allAvailable = ribbonAX !== null && ribbonAY !== null && ribbonBX !== null && ribbonBY !== null;
		const currentRibbonCost = allAvailable ? ribbonAX + ribbonBY : null;
		const swappedRibbonCost = allAvailable ? ribbonAY + ribbonBX : null;
		const ribbonImprovementPx =
			currentRibbonCost !== null && swappedRibbonCost !== null ? currentRibbonCost - swappedRibbonCost : null;
		const eligible =
			currentRibbonCost !== null &&
			swappedRibbonCost !== null &&
			swappedRibbonCost < currentRibbonCost &&
			ribbonImprovementPx !== null &&
			ribbonImprovementPx >= MIN_RIBBON_IMPROVEMENT_PX;
		return {
			holeA,
			holeB,
			basketX,
			basketY,
			lowParAX: holeA.lowParScore,
			lowParAY: candidateAY.lowParScore,
			lowParBX: candidateBX.lowParScore,
			lowParBY: holeB.lowParScore,
			ribbonAX,
			ribbonAY,
			ribbonBX,
			ribbonBY,
			currentRibbonCost,
			swappedRibbonCost,
			ribbonImprovementPx,
			eligible
		};
	});

	const swappedHoleNumbers = new Set<number>();
	const appliedPairIndexes = new Set<number>();
	const byImprovementDesc = evaluations
		.map((evaluation, index) => ({ evaluation, index }))
		.filter(({ evaluation }) => evaluation.eligible)
		.sort((left, right) => (right.evaluation.ribbonImprovementPx ?? 0) - (left.evaluation.ribbonImprovementPx ?? 0));
	for (const { evaluation, index } of byImprovementDesc) {
		if (swappedHoleNumbers.has(evaluation.holeA.holeNumber) || swappedHoleNumbers.has(evaluation.holeB.holeNumber)) {
			continue;
		}
		appliedPairIndexes.add(index);
		swappedHoleNumbers.add(evaluation.holeA.holeNumber);
		swappedHoleNumbers.add(evaluation.holeB.holeNumber);
	}

	const pairs: P6SwapPairDiagnostic[] = evaluations.map((evaluation, index) => ({
		holeA: evaluation.holeA.holeNumber,
		holeB: evaluation.holeB.holeNumber,
		basketX: evaluation.basketX,
		basketY: evaluation.basketY,
		lowParAX: evaluation.lowParAX,
		lowParAY: evaluation.lowParAY,
		lowParBX: evaluation.lowParBX,
		lowParBY: evaluation.lowParBY,
		ribbonAX: evaluation.ribbonAX,
		ribbonAY: evaluation.ribbonAY,
		ribbonBX: evaluation.ribbonBX,
		ribbonBY: evaluation.ribbonBY,
		currentRibbonCost: evaluation.currentRibbonCost,
		swappedRibbonCost: evaluation.swappedRibbonCost,
		ribbonImprovementPx: evaluation.ribbonImprovementPx,
		swapApplied: appliedPairIndexes.has(index)
	}));

	return {
		pairsConsidered: pairs.length,
		swapsApplied: appliedPairIndexes.size,
		changedHoleNumbers: Array.from(swappedHoleNumbers).sort((left, right) => left - right),
		ms: performance.now() - startedAt,
		pairs
	};
}

/** Applies confirmed P6.2 swaps to the P6.1 gated snapshot; a no-op when nothing swapped. */
function applySwapAdjudication(
	gatedP6: P6LowParBasketAssignmentSnapshot,
	swapAdjudication: P6SwapAdjudicationResult
): P6LowParBasketAssignmentSnapshot {
	if (swapAdjudication.swapsApplied === 0) return gatedP6;

	const candidateByHoleAndBasket = new Map<string, P6BasketCandidate>();
	for (const candidate of gatedP6.candidates) {
		candidateByHoleAndBasket.set(`${candidate.holeNumber}:${candidate.basketIndex}`, candidate);
	}
	const newBasketByHole = new Map<number, number>();
	for (const pair of swapAdjudication.pairs) {
		if (!pair.swapApplied) continue;
		newBasketByHole.set(pair.holeA, pair.basketY);
		newBasketByHole.set(pair.holeB, pair.basketX);
	}

	const assignments = gatedP6.assignments.map((assignment): P6BasketAssignment => {
		const newBasketIndex = newBasketByHole.get(assignment.holeNumber);
		if (newBasketIndex === undefined) return assignment;
		const candidate = candidateByHoleAndBasket.get(`${assignment.holeNumber}:${newBasketIndex}`);
		return {
			...assignment,
			assignedBasketIndex: newBasketIndex,
			assignedForwardAngleDeg: candidate?.forwardAngleDeg ?? assignment.assignedForwardAngleDeg,
			lowParScore: candidate?.lowParScore ?? assignment.lowParScore
		};
	});
	const totalAssignmentCost = assignments
		.filter(
			(assignment): assignment is P6BasketAssignment & { readonly lowParScore: number } =>
				assignment.status === 'lowParAssigned' && assignment.lowParScore !== null
		)
		.reduce(
			(total, assignment) => total + (LOW_PAR_HIGHER_IS_BETTER ? -assignment.lowParScore : assignment.lowParScore),
			0
		);

	return { ...gatedP6, assignments, totalAssignmentCost };
}

/**
 * `ribbonSegmentation` is the SAME segmentation P4 was derived from — built
 * once by the caller (see `basketDetection.worker.ts`) and passed down here
 * so P6.2's ribbon-distance evidence never re-segments the raster.
 */
export function deriveP6LowParBasketAssignment(
	raster: CorridorBendRaster,
	tees: readonly RawMaskTee[],
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	p5: P5SparseAssignmentResult,
	p4: P4RibbonOwnershipResult,
	ribbonSegmentation: RibbonMassSegmentation,
	options: P6LowParOptions = {}
): P6LowParBasketAssignmentResult {
	const originalP6 = deriveP6LowParBasketAssignmentSnapshot(raster, tees, baskets, badges, p5, p4, false, options);
	const gatedP6 = deriveP6LowParBasketAssignmentSnapshot(raster, tees, baskets, badges, p5, p4, true, options);
	const swapAdjudication = derive2x2SwapAdjudication(gatedP6, ribbonSegmentation, baskets, badges);
	const adjudicatedP6 = applySwapAdjudication(gatedP6, swapAdjudication);
	return {
		...adjudicatedP6,
		originalP6,
		changedHoleNumbers: changedP6HoleNumbers(originalP6, gatedP6),
		swapAdjudication
	};
}
