// A course with N badges and fewer than N shipped assignments used to print
// only a buried aggregate count (e.g. teeBadgeLock's own unmatchedBadges
// measurement) with no per-hole detail. This module names the hole itself:
// which badge has no shipped tee, plus the cheapest honest breadcrumb this
// run's own trace already carries for it.
//
// "Cheapest honest" means: never compute new detector work here. Only two
// sources are consulted, both already produced by this run when scheduled:
//   1. teeBadgeLock (a default-OFF alternative matcher) -- its own accepted
//      lock or abstention reason for this exact badge, if that unit ran.
//   2. G4 teeRecovery's rejected-candidate narration, matched by badge
//      ordinal, if teeBadgeLock has nothing.
// Absent both, the row says so plainly rather than inventing a reason.

import type { HoleLabeledAssignment } from '@chainspot/alg/exec';
import type { RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';

export interface NotFoundBadgeSource {
	readonly detId: string;
	/** G1-read digit label, or null when the read failed (UNREAD). */
	readonly label: string | null;
	readonly confidence: number | null;
}

export interface NotFoundBadgeRow {
	readonly hole: string;
	readonly holeConfidence: number | null;
	readonly badgeId: string;
	readonly breadcrumb: string;
}

function badgeOrdinal(badgeId: string): string | undefined {
	return /^badge-(\d+)$/.exec(badgeId)?.[1];
}

function breadcrumbFor(badgeId: string, trace: RunTrace): string {
	const teeBadgeLock = trace.units.find((unit) => unit.id === 'teeBadgeLock');
	if (teeBadgeLock) {
		const lockPrefix = `teeBadgeLock:${badgeId}:`;
		const lock = teeBadgeLock.drawables.find(
			(drawable) => drawable.verdict === 'accepted' && drawable.ref?.startsWith(lockPrefix)
		);
		if (lock) {
			const teeId = lock.ref!.slice(lockPrefix.length);
			return `teeBadgeLock (default-OFF, ALTERNATIVE HYPOTHESIS, not shipped) locked this badge to ${teeId}: ${lock.reason ?? 'no reason recorded'}`;
		}
		const abstention = teeBadgeLock.drawables.find(
			(drawable) => drawable.verdict === 'rejected' && drawable.ref === `teeBadgeLockAbstention:${badgeId}`
		);
		if (abstention) return `teeBadgeLock (default-OFF) abstained: ${abstention.reason ?? 'no reason recorded'}`;
	}
	const ordinal = badgeOrdinal(badgeId);
	const teeRecovery = trace.units.find((unit) => unit.id === 'teeRecovery');
	if (ordinal && teeRecovery) {
		const rejected = teeRecovery.drawables.find(
			(drawable) => drawable.verdict === 'rejected' && drawable.reason?.includes(`badge ${ordinal}:`)
		);
		if (rejected) return `nearest rejected tee candidate (G4 teeRecovery): ${rejected.reason}`;
	}
	return 'no rejected-tee evidence for this badge is carried in this trace';
}

/** Every G1-read badge with no row in the shipped assignment board, sourced
 * by set difference against the exact same assignmentRows the HOLE
 * ASSIGNMENTS table prints -- the two surfaces can never disagree on which
 * badge is missing. */
export function findUnassignedBadges(
	badges: readonly NotFoundBadgeSource[],
	assignmentRows: readonly HoleLabeledAssignment[],
	trace: RunTrace
): readonly NotFoundBadgeRow[] {
	const assignedIds = new Set(assignmentRows.map((row) => row.badgeId));
	return badges
		.filter((badge) => !assignedIds.has(badge.detId))
		.map((badge) => ({
			hole: badge.label ?? 'UNREAD',
			holeConfidence: badge.label !== null ? badge.confidence : null,
			badgeId: badge.detId,
			breadcrumb: breadcrumbFor(badge.detId, trace)
		}));
}

/** Numeric ascending by hole label; UNREAD sorts last (it is not a hole
 * number, so it cannot be interleaved with real ones). */
export function holeSortKey(hole: string): number {
	return hole === 'UNREAD' ? Number.POSITIVE_INFINITY : Number(hole);
}

export function sortByHole<T extends { readonly hole: string }>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => holeSortKey(a.hole) - holeSortKey(b.hole));
}

/** Rendered ABOVE the HOLE ASSIGNMENTS table in both run.receipt.txt and
 * run.visual.receipt.txt so a missing hole is never left to a buried count. */
export function notFoundReceiptLines(rows: readonly NotFoundBadgeRow[]): string[] {
	const lines = [
		'NOT FOUND (badges with no shipped assignment)',
		'(provenance: every G1-read badge absent from the HOLE ASSIGNMENTS table below; the breadcrumb is the cheapest evidence this run already carries, never new detector work)'
	];
	if (rows.length === 0) {
		lines.push('(none -- every badge has a shipped assignment)');
		return lines;
	}
	lines.push('hole | badgeId | note');
	for (const row of sortByHole(rows)) {
		const holeLabel = row.hole === 'UNREAD' ? 'UNREAD' : `H${row.hole}`;
		lines.push(`${holeLabel} | ${row.badgeId} | no tee assigned -- ${row.breadcrumb}`);
	}
	return lines;
}
