from pathlib import Path

p=Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s=p.read_text()

old="""export interface VisibleTeeBadgeRayClaim {
\treadonly teeId: string;
\treadonly badgeId: string;
\treadonly badgeLabel: string | null;
\treadonly axisErrorRad: number;
\treadonly perpendicularErrorPx: number;
\treadonly alongPx: number;
\treadonly direction: -1 | 1;
}
"""
new="""export interface VisibleTeeBadgeRayClaim {
\treadonly teeId: string;
\treadonly badgeId: string;
\treadonly badgeLabel: string | null;
\t/** Kept as presentation testimony only; no degree threshold gates visible ownership. */
\treadonly axisErrorRad: number;
\treadonly perpendicularErrorPx: number;
\t/** Measured geometry-derived allowance at this badge distance. */
\treadonly perpendicularBoundPx: number;
\treadonly angleBoundRad: number;
\treadonly alongPx: number;
\treadonly direction: -1 | 1;
}
"""
if s.count(old)!=1: raise SystemExit('claim interface drifted')
s=s.replace(old,new,1)

start=s.index('/**\n * Cheap G4 testimony for already-visible tees.')
end=s.index('\nfunction exactBasketPixels(', start)
replacement=r'''/**
 * Cheap G4 testimony for already-visible tees.
 *
 * The badge target is its semantic CENTER, not its generous bbox. A visible
 * pad supplies a measured centerline plus a built-in uncertainty envelope:
 * raster center uncertainty + the course-local P100 pad-width spread + the
 * finite major-span orientation uncertainty projected out to badge distance.
 * No degree threshold, pathfinding, or assignment evidence participates.
 */
export function resolveVisibleTeeBadgeRays(
	tees: readonly TeeEvidence[],
	badges: readonly BadgeEvidence[]
): VisibleTeeBadgeRayResolution {
	const numbered = badges.filter((badge) => numberLabel(badge) !== undefined);
	const claims: VisibleTeeBadgeRayClaim[] = [];
	const ambiguousTeeIds: string[] = [];
	const measuredWidths = tees
		.map((tee) => tee.pad?.minorPx)
		.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
		.sort((a, b) => a - b);
	const knownPadWidthPx = measuredWidths[Math.floor(measuredWidths.length / 2)] ?? 0;
	const knownHalfWidthErrorPx = measuredWidths.length === 0
		? 0
		: Math.max(...measuredWidths.map((width) => Math.abs(width - knownPadWidthPx))) / 2;

	for (const tee of tees) {
		const pose = tee.pad?.minAreaPose;
		const axisRad = pose?.angleRad ?? tee.pad?.angleRad ?? tee.angleRad;
		const xPx = pose?.centerXPx ?? tee.pad?.centerXPx ?? tee.xPx;
		const yPx = pose?.centerYPx ?? tee.pad?.centerYPx ?? tee.yPx;
		const majorPx = pose?.majorPx ?? tee.pad?.majorPx;
		const minorPx = pose?.minorPx ?? tee.pad?.minorPx;
		if (!tee.pad || axisRad === null || !Number.isFinite(axisRad) || !majorPx || !minorPx) continue;
		const c = Math.cos(axisRad), ss = Math.sin(axisRad);
		const halfPad = majorPx / 2;
		// A full visible pad's centerline is bracketed by its own rails. The only
		// normal-position allowance is raster quantization plus the measured
		// course-local width spread; orientation uncertainty is independently
		// derived from finite observed major span.
		const centerNormalBoundPx = RASTER_TOLERANCE_PX + knownHalfWidthErrorPx;
		const angleBoundRad = Math.atan2(RASTER_TOLERANCE_PX, Math.max(RASTER_TOLERANCE_PX, majorPx / 2));
		const firstIntercepts: VisibleTeeBadgeRayClaim[] = [];
		for (const direction of [-1, 1] as const) {
			const hits = numbered.flatMap((badge) => {
				const dx = badge.cxPx - xPx, dy = badge.cyPx - yPx;
				const alongSigned = dx * c + dy * ss;
				const alongPx = direction * alongSigned;
				if (alongPx <= halfPad) return [];
				const perpendicularErrorPx = Math.abs(-dx * ss + dy * c);
				const orientationBoundPx = alongPx * Math.sin(angleBoundRad);
				const perpendicularBoundPx = centerNormalBoundPx + orientationBoundPx;
				if (perpendicularErrorPx > perpendicularBoundPx) return [];
				return [{
					claim: {
						teeId: tee.detId,
						badgeId: badge.detId,
						badgeLabel: badge.label,
						axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx)),
						perpendicularErrorPx,
						perpendicularBoundPx,
						angleBoundRad,
						alongPx,
						direction
					} satisfies VisibleTeeBadgeRayClaim,
					alongPx
				}];
			}).sort((a, b) => a.alongPx - b.alongPx || a.claim.badgeId.localeCompare(b.claim.badgeId));
			if (hits[0]) firstIntercepts.push(hits[0].claim);
		}
		claims.push(...firstIntercepts);
		if (firstIntercepts.length > 1) ambiguousTeeIds.push(tee.detId);
	}

	const byTee = new Map<string, VisibleTeeBadgeRayClaim[]>();
	const byBadge = new Map<string, VisibleTeeBadgeRayClaim[]>();
	for (const claim of claims) {
		const teeBucket = byTee.get(claim.teeId);
		if (teeBucket) teeBucket.push(claim); else byTee.set(claim.teeId, [claim]);
		const badgeBucket = byBadge.get(claim.badgeId);
		if (badgeBucket) badgeBucket.push(claim); else byBadge.set(claim.badgeId, [claim]);
	}
	const locks = claims.filter((claim) =>
		(byTee.get(claim.teeId)?.length ?? 0) === 1 &&
		(byBadge.get(claim.badgeId)?.length ?? 0) === 1
	);
	const conflictedBadgeIds = [...byBadge.entries()]
		.filter(([, bucket]) => bucket.length > 1)
		.map(([badgeId]) => badgeId)
		.sort();
	const coveredBadgeIds = [...new Set(claims.map((claim) => claim.badgeId))].sort();
	claims.sort((a, b) => a.badgeId.localeCompare(b.badgeId) || a.teeId.localeCompare(b.teeId));
	locks.sort((a, b) => a.badgeId.localeCompare(b.badgeId) || a.teeId.localeCompare(b.teeId));
	ambiguousTeeIds.sort();
	return { claims, locks, coveredBadgeIds, ambiguousTeeIds, conflictedBadgeIds };
}
'''
s=s[:start]+replacement+s[end:]

old="""\t\t\t\treason: locked
\t\t\t\t\t? `LOCK: visible ${tee.detId} has one first-intercept badge and badge ${badge.label ?? badge.detId} has one visible-tee claimant; perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px; no pathfinding or assignment testimony read`
\t\t\t\t\t: `POSSIBLE: visible ${tee.detId} supplies first-intercept testimony for badge ${badge.label ?? badge.detId} (perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px); multiclaim/conflict is preserved as coverage, not erased into a false recovery target`
"""
new="""\t\t\t\treason: locked
\t\t\t\t\t? `LOCK: visible ${tee.detId} has one first-intercept badge and badge ${badge.label ?? badge.detId} has one visible-tee claimant; projected centerline miss ${claim.perpendicularErrorPx.toFixed(3)}px <= built-in ${claim.perpendicularBoundPx.toFixed(3)}px bound; no pathfinding or assignment testimony read`
\t\t\t\t\t: `POSSIBLE: visible ${tee.detId} supplies first-intercept testimony for badge ${badge.label ?? badge.detId}; projected centerline miss ${claim.perpendicularErrorPx.toFixed(3)}px <= built-in ${claim.perpendicularBoundPx.toFixed(3)}px bound; multiclaim/conflict is preserved as coverage, not erased into a false recovery target`
"""
if s.count(old)!=1: raise SystemExit('visible receipt wording drifted')
s=s.replace(old,new,1)

# Add aggregate visibility-bound telemetry beside claim counts.
old="""\t\tctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
\t\tctx.measure('teeRecovery', 'visibleRayLocks', rayResolution.locks.length);
"""
new="""\t\tctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
\t\tctx.measure('teeRecovery', 'visibleRayLocks', rayResolution.locks.length);
\t\tfor (const claim of rayResolution.claims) {
\t\t\tctx.measure('teeRecovery', 'visibleRayPerpendicularErrorPx', claim.perpendicularErrorPx);
\t\t\tctx.measure('teeRecovery', 'visibleRayPerpendicularBoundPx', claim.perpendicularBoundPx);
\t\t\tctx.measure('teeRecovery', 'visibleRayAngleBoundDeg', claim.angleBoundRad * 180 / Math.PI);
\t\t}
"""
if s.count(old)!=1: raise SystemExit('visible metrics anchor drifted')
s=s.replace(old,new,1)

p.write_text(s)
print('patched', p)
