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

export const P6_DISALLOWED_COST = 1_000_000;
export const LOW_PAR_HIGHER_IS_BETTER = true;

const LOW_PAR_LINE_SAMPLE_STEP_SRC_PX = 2 * 3;
const LOW_PAR_TRIM_FRACTION = 0.2;
const LOW_PAR_LENGTH_PENALTY_ALPHA = 0.2;
const LOW_PAR_MIN_SAMPLE_COUNT = 5;
const LOW_PAR_BADGE_MASK_HALF_WIDTH_SRC_PX = 34;
const LOW_PAR_BADGE_MASK_HALF_HEIGHT_SRC_PX = 24;
export const P6_FORWARD_GATE_ANGLE_DEG = 80;

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

export type P6BasketAssignmentStatus = 'p4Locked' | 'lowParAssigned' | 'unresolved';
export type P6BasketAssignmentReason = 'p4Locked' | 'lowPar' | 'noValidAssignment';

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

function forwardGateForBasket(
	tee: SourcePoint,
	badge: SourcePoint,
	basket: RawMaskBasket
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
	useForwardGate: boolean
): P6LowParBasketAssignmentSnapshot {
	const p4ByHole = p4HoleByNumber(p4);
	const p5ByHole = p5AssignmentByHole(p5);
	const sharedComponents = new Set(p4.sharedComponentLabels);
	const p4Locks = new Map<number, number>();
	for (const hole of p4.holes) {
		if (isHardP4BasketLock(hole, sharedComponents)) p4Locks.set(hole.holeNumber, hole.basketIndexes[0]);
	}
	const lockedBasketIndexes = new Set(p4Locks.values());
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
		if (p4Locks.has(holeNumber)) continue;
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
				const lowParScore = scoreLowParBasketCandidate(
					evidenceGrid,
					{ xPx: tee.xPx, yPx: tee.yPx },
					{ xPx: badge.xPx, yPx: badge.yPx },
					{ xPx: basket.centerXPx, yPx: basket.centerYPx }
				);
				return {
					holeNumber,
					basketIndex,
					...forwardGateForBasket(
						{ xPx: tee.xPx, yPx: tee.yPx },
						{ xPx: badge.xPx, yPx: badge.yPx },
						basket
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

	const solveRows = holeNumbers.filter((holeNumber) => !p4Locks.has(holeNumber) && candidatesByHole.has(holeNumber));
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

export function deriveP6LowParBasketAssignment(
	raster: CorridorBendRaster,
	tees: readonly RawMaskTee[],
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	p5: P5SparseAssignmentResult,
	p4: P4RibbonOwnershipResult
): P6LowParBasketAssignmentResult {
	const originalP6 = deriveP6LowParBasketAssignmentSnapshot(raster, tees, baskets, badges, p5, p4, false);
	const gatedP6 = deriveP6LowParBasketAssignmentSnapshot(raster, tees, baskets, badges, p5, p4, true);
	return {
		...gatedP6,
		originalP6,
		changedHoleNumbers: changedP6HoleNumbers(originalP6, gatedP6)
	};
}
