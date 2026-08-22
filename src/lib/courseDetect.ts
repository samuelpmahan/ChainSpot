// Badge-seeded hole proposal — pure merging of same-hole detections.
//
// This is the SLICE-4 'badge-seeded, minimal' increment: groups coincident
// hole-badge sightings (from Stage 2's Stitch Map) into one draft proposal per
// hole number. Positions are already in composite space (caller projects per-image
// detections through current tile placements), so this function is pure and cheap;
// the caller re-invokes it whenever placements change.
//
// Pixel search for tee/basket/bend locations is deferred. Every proposal this slice
// carries null/null/[] to signal GuidedReview that the hole needs full manual placement.

export interface SeedBadge {
	readonly n: number;
	readonly xPx: number;
	readonly yPx: number;
}

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

export interface HoleProposal {
	readonly n: number;
	readonly tee: Point | null;
	readonly basket: Point | null;
	readonly bends: readonly Point[];
}

/**
 * Merge badge detections into draft hole proposals.
 * Accepts badges, filters out malformed entries (n <= 0, non-finite coords),
 * groups by hole number n, and returns one HoleProposal per distinct n
 * (sorted ascending), with position as the arithmetic mean of its sightings.
 */
export function detectCourse(badges: readonly SeedBadge[]): HoleProposal[] {
	const byN = new Map<number, Point[]>();

	for (const badge of badges) {
		// Skip malformed entries: invalid hole number or non-finite coordinates.
		if (badge.n <= 0 || !Number.isFinite(badge.xPx) || !Number.isFinite(badge.yPx)) {
			continue;
		}

		const existing = byN.get(badge.n);
		if (existing) {
			existing.push({ xPx: badge.xPx, yPx: badge.yPx });
		} else {
			byN.set(badge.n, [{ xPx: badge.xPx, yPx: badge.yPx }]);
		}
	}

	// Convert to proposals, sorted by n ascending.
	const proposals: HoleProposal[] = Array.from(byN.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([n]) => ({
			n,
			tee: null,
			basket: null,
			bends: [],
		}));

	return proposals;
}
