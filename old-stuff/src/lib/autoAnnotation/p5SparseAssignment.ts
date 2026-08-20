/**
 * Pancake 5: sparse one-to-one tee -> labeled-badge assignment.
 *
 * This stage arbitrates only the candidate edges already emitted by P3 and
 * constrained by decisive unbridged P4 results. It does not create geometry,
 * score distances, or assign baskets.
 */

import type { P4RibbonOwnershipResult, P4TeeResolution } from './p4RibbonOwnership';
import type { P2LabeledBadge, P3OwnershipResult } from './rawObjectOwnership';
import type { RawMaskTee } from './rawObjectMask';

export const DISALLOWED_COST = 1_000_000;

export type P5TeeAssignmentStatus = 'assigned' | 'unresolved';
export type P5TeeAssignmentReason = 'p4Resolved' | 'hungarian' | 'noValidAssignment';

export interface P5TeeAssignment {
	readonly teeIndex: number;
	readonly assignedHoleNumber: number | null;
	readonly candidateHoleNumbers: readonly number[];
	readonly assignedAxisErrorPx: number | null;
	readonly p4Status: P4TeeResolution['status'] | 'unresolved';
	readonly p4HoleNumber: number | null;
	readonly status: P5TeeAssignmentStatus;
	readonly reason: P5TeeAssignmentReason;
}

export interface P5SparseAssignmentResult {
	readonly assignments: readonly P5TeeAssignment[];
	readonly assignedTees: number;
	readonly unresolvedTees: number;
	readonly totalAssignmentCost: number;
	readonly duplicateBadges: readonly number[];
	readonly disallowedAssignmentsRejected: number;
	readonly perfectMatchingFound: boolean;
}

/**
 * Local copy of the existing course-grammar Hungarian minimum-cost routine.
 *
 * This helper minimizes its input matrix. P3/P4 axis errors therefore remain
 * positive costs, while the finite disallowed sentinel is deliberately large.
 */
function hungarian(cost: readonly (readonly number[])[]): number[] {
	const rowCount = cost.length;
	if (rowCount === 0) return [];
	const columnCount = cost[0]?.length ?? 0;
	if (columnCount < rowCount) throw new Error('P5 Hungarian assignment requires at least as many columns as rows.');
	if (cost.some((row) => row.length !== columnCount)) throw new Error('P5 Hungarian assignment received a ragged cost matrix.');

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

function hasPerfectAllowedMatching(
	matrix: readonly (readonly number[])[],
	disallowedCost: number
): boolean {
	const columnCount = matrix[0]?.length ?? 0;
	const ownerByColumn = new Array<number>(columnCount).fill(-1);

	function augment(rowIndex: number, visitedColumns: Set<number>): boolean {
		for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
			const cost = matrix[rowIndex][columnIndex];
			if (!Number.isFinite(cost) || cost >= disallowedCost || visitedColumns.has(columnIndex)) continue;
			visitedColumns.add(columnIndex);
			const previousRow = ownerByColumn[columnIndex];
			if (previousRow === -1 || augment(previousRow, visitedColumns)) {
				ownerByColumn[columnIndex] = rowIndex;
				return true;
			}
		}
		return false;
	}

	for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
		if (!augment(rowIndex, new Set<number>())) return false;
	}
	return true;
}

function uniqueNumbers(values: readonly number[]): number[] {
	return Array.from(new Set(values));
}

function p4ResolutionByTee(p4: P4RibbonOwnershipResult): Map<number, P4TeeResolution> {
	return new Map(p4.teeResolutions.map((resolution) => [resolution.teeIndex, resolution]));
}

interface P5Row {
	readonly candidateHoleNumbers: readonly number[];
	readonly p4Status: P4TeeResolution['status'] | 'unresolved';
	readonly p4HoleNumber: number | null;
	readonly costsByHole: ReadonlyMap<number, number>;
}

function buildRow(
	teeIndex: number,
	p2Badges: ReadonlySet<number>,
	p3: P3OwnershipResult,
	p4ByTee: ReadonlyMap<number, P4TeeResolution>
): P5Row {
	const diagnostic = p3.teeDiagnostics.find((candidate) => candidate.teeIndex === teeIndex);
	const p4Resolution = p4ByTee.get(teeIndex);
	const p3Candidates = uniqueNumbers(diagnostic?.candidateHoleNumbers ?? []);
	const p3AxisErrorByHole = new Map(
		(diagnostic?.candidateBadgeEvidence ?? []).map((evidence) => [evidence.holeNumber, evidence.badgeAxisErrorPx])
	);
	const candidateHoleNumbers = p4Resolution?.status === 'resolved'
		? p4Resolution.resolvedHoleNumber === undefined
			? []
			: [p4Resolution.resolvedHoleNumber]
		: p3Candidates.filter((holeNumber) => p2Badges.has(holeNumber));
	const costsByHole = new Map<number, number>();
	for (const holeNumber of candidateHoleNumbers) {
		const badgeAxisErrorPx = p3AxisErrorByHole.get(holeNumber);
		if (badgeAxisErrorPx !== undefined && Number.isFinite(badgeAxisErrorPx)) {
			costsByHole.set(holeNumber, badgeAxisErrorPx);
		}
	}
	return {
		candidateHoleNumbers,
		p4Status: p4Resolution?.status ?? 'unresolved',
		p4HoleNumber: p4Resolution?.resolvedHoleNumber ?? null,
		costsByHole
	};
}

export function deriveP5SparseAssignment(
	tees: readonly RawMaskTee[],
	badges: readonly P2LabeledBadge[],
	p3: P3OwnershipResult,
	p4: P4RibbonOwnershipResult
): P5SparseAssignmentResult {
	const badgeNumbers = uniqueNumbers(badges.map((badge) => badge.holeNumber)).sort((a, b) => a - b);
	const p2BadgeNumbers = new Set(badgeNumbers);
	const p4ByTee = p4ResolutionByTee(p4);
	const rows = tees.map((_, teeIndex) => buildRow(teeIndex, p2BadgeNumbers, p3, p4ByTee));

	// Keep the solver interface rectangular even if a malformed/dev input has
	// fewer P2 labels than raw tees. Null columns are always disallowed.
	const columnCount = Math.max(tees.length, badgeNumbers.length);
	const columns: readonly (number | null)[] = [
		...badgeNumbers,
		...new Array<number | null>(columnCount - badgeNumbers.length).fill(null)
	];
	const matrix = rows.map((row) =>
		columns.map((holeNumber) => {
			if (holeNumber === null || !row.candidateHoleNumbers.includes(holeNumber)) return DISALLOWED_COST;
			return row.costsByHole.get(holeNumber) ?? DISALLOWED_COST;
		})
	);
	const perfectAllowedMatchingExists = hasPerfectAllowedMatching(matrix, DISALLOWED_COST);
	const solverAssignments = hungarian(matrix);

	let disallowedAssignmentsRejected = 0;
	const provisional = rows.map((row, teeIndex): P5TeeAssignment => {
		const columnIndex = solverAssignments[teeIndex] ?? -1;
		const assignedHoleNumber = columnIndex < 0 ? null : columns[columnIndex] ?? null;
		const assignedCost = columnIndex < 0 ? DISALLOWED_COST : matrix[teeIndex][columnIndex];
		const validAllowedEdge =
			assignedHoleNumber !== null &&
			row.candidateHoleNumbers.includes(assignedHoleNumber) &&
			Number.isFinite(assignedCost) &&
			assignedCost < DISALLOWED_COST;
		if (!validAllowedEdge) disallowedAssignmentsRejected += 1;
		return {
			teeIndex,
			assignedHoleNumber: validAllowedEdge ? assignedHoleNumber : null,
			candidateHoleNumbers: row.candidateHoleNumbers,
			assignedAxisErrorPx: validAllowedEdge ? assignedCost : null,
			p4Status: row.p4Status,
			p4HoleNumber: row.p4HoleNumber,
			status: validAllowedEdge ? 'assigned' : 'unresolved',
			reason: validAllowedEdge
				? row.p4Status === 'resolved'
					? 'p4Resolved'
					: 'hungarian'
				: 'noValidAssignment'
		};
	});

	const ownersByBadge = new Map<number, number[]>();
	for (const assignment of provisional) {
		if (assignment.assignedHoleNumber === null) continue;
		const owners = ownersByBadge.get(assignment.assignedHoleNumber) ?? [];
		owners.push(assignment.teeIndex);
		ownersByBadge.set(assignment.assignedHoleNumber, owners);
	}
	const duplicateBadges = Array.from(ownersByBadge.entries())
		.filter(([, owners]) => owners.length > 1)
		.map(([holeNumber]) => holeNumber);
	const duplicateRows = new Set(
		Array.from(ownersByBadge.values())
			.filter((owners) => owners.length > 1)
			.flat()
	);
	const assignments = provisional.map((assignment) =>
		duplicateRows.has(assignment.teeIndex)
			? { ...assignment, assignedHoleNumber: null, assignedAxisErrorPx: null, status: 'unresolved' as const, reason: 'noValidAssignment' as const }
			: assignment
	);
	const assignedTees = assignments.filter((assignment) => assignment.status === 'assigned').length;
	const unresolvedTees = assignments.filter((assignment) => assignment.status === 'unresolved').length;
	if (perfectAllowedMatchingExists && disallowedAssignmentsRejected > 0) {
		console.error(
			'P5 Hungarian implementation error: sparse graph has perfect matching but solver selected disallowed edge'
		);
	}

	return {
		assignments,
		assignedTees,
		unresolvedTees,
		totalAssignmentCost: assignments.reduce(
			(total, assignment) => total + (assignment.assignedAxisErrorPx ?? 0),
			0
		),
		duplicateBadges,
		disallowedAssignmentsRejected,
		perfectMatchingFound: assignedTees === 18 && unresolvedTees === 0 && disallowedAssignmentsRejected === 0
	};
}
