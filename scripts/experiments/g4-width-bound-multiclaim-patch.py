from pathlib import Path

p = Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s = p.read_text()


def once(old: str, new: str, label: str) -> None:
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {s.count(old)}')
    s = s.replace(old, new, 1)

# The projected pad width creates a real error bound; retain it in custody/receipts.
once(
"""\treadonly badgePerpendicularMissPx?: number;
\treadonly projectedLaneWidthPx?: number;
""",
"""\treadonly badgePerpendicularMissPx?: number;
\t/** Error budget implied by observed rail uncertainty + the observed spread
\t * of already-known course-local pad widths + raster quantization. */
\treadonly badgePerpendicularBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
""",
'RecoveryFit bound field')

once(
"""\treadonly badgePerpendicularMissPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
\treadonly railProjection?: number;
""",
"""\treadonly badgePerpendicularMissPx?: number;
\treadonly badgePerpendicularBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
\treadonly railProjection?: number;
""",
'TeeRecoveryValues bound field')

once(
"""\t/** Set when this exact component set also satisfies the strict predicate
\t * for another missing badge that wins the axis-error tiebreak. Forces
\t * rejection here so a genuine ambiguity is never silently resolved by
\t * loop order -- the winner's badge label is named so the trade-off is
\t * visible. */
\treadonly ambiguityLostToBadgeLabel?: string | null;
""",
"""\t/** Other numbered badges supported by this exact component set. G4 is
\t * deliberately nonmonotonic about belief but monotonic about evidence:
\t * multiclaim is preserved and every claimant is deferred, never collapsed
\t * to a local winner. */
\treadonly ambiguityWithBadgeLabels?: readonly string[];
""",
'candidate ambiguity provenance')

# Replace the visible-tee resolver wholesale: POSSIBLE coverage is preserved;
# LOCK is only the subset that is unique from both tee and badge perspectives.
start = s.index('export function resolveVisibleTeeBadgeRays(')
end = s.index('\nfunction exactBasketPixels(', start)
new_resolver = r'''export function resolveVisibleTeeBadgeRays(
	tees: readonly TeeEvidence[],
	badges: readonly BadgeEvidence[]
): VisibleTeeBadgeRayResolution {
	const numbered = badges.filter((badge) => numberLabel(badge) !== undefined);
	const claims: VisibleTeeBadgeRayClaim[] = [];
	const ambiguousTeeIds: string[] = [];

	for (const tee of tees) {
		const pose = tee.pad?.minAreaPose;
		const axisRad = pose?.angleRad ?? tee.pad?.angleRad ?? tee.angleRad;
		const xPx = pose?.centerXPx ?? tee.pad?.centerXPx ?? tee.xPx;
		const yPx = pose?.centerYPx ?? tee.pad?.centerYPx ?? tee.yPx;
		const majorPx = pose?.majorPx ?? tee.pad?.majorPx;
		const minorPx = pose?.minorPx ?? tee.pad?.minorPx;
		if (!tee.pad || axisRad === null || !Number.isFinite(axisRad) || !majorPx || !minorPx) continue;
		const c = Math.cos(axisRad), ss = Math.sin(axisRad);
		// POSSIBLE testimony is intentionally a pad-width corridor, not a point
		// winner. It exists only to answer "could this already-visible tee own
		// this badge?" so G4 does not hallucinate a recovery on top of evidence
		// it already has. Later stages may resolve the relation.
		const halfLane = minorPx / 2 + RASTER_TOLERANCE_PX;
		const halfPad = majorPx / 2;
		const byDirection = new Map<-1 | 1, { claim: VisibleTeeBadgeRayClaim; alongPx: number }[]>();
		for (const badge of numbered) {
			const dx = badge.cxPx - xPx;
			const dy = badge.cyPx - yPx;
			const along = dx * c + dy * ss;
			const perpendicular = Math.abs(-dx * ss + dy * c);
			if (perpendicular > halfLane || Math.abs(along) <= halfPad) continue;
			const direction = (along < 0 ? -1 : 1) as -1 | 1;
			const bucket = byDirection.get(direction) ?? [];
			bucket.push({
				claim: {
					teeId: tee.detId,
					badgeId: badge.detId,
					badgeLabel: badge.label,
					axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx)),
					perpendicularErrorPx: perpendicular,
					alongPx: Math.abs(along),
					direction
				},
				alongPx: Math.abs(along)
			});
			byDirection.set(direction, bucket);
		}
		const firstIntercepts: VisibleTeeBadgeRayClaim[] = [];
		for (const bucket of byDirection.values()) {
			bucket.sort((a, b) => a.alongPx - b.alongPx || a.claim.badgeId.localeCompare(b.claim.badgeId));
			if (bucket[0]) firstIntercepts.push(bucket[0].claim);
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
s = s[:start] + new_resolver + s[end:]

once(
"""export interface VisibleTeeBadgeRayClaim {
\treadonly teeId: string;
\treadonly badgeId: string;
\treadonly badgeLabel: string | null;
\treadonly axisErrorRad: number;
}

export interface VisibleTeeBadgeRayResolution {
\treadonly claims: readonly VisibleTeeBadgeRayClaim[];
\treadonly ambiguousTeeIds: readonly string[];
\treadonly conflictedBadgeIds: readonly string[];
}
""",
"""export interface VisibleTeeBadgeRayClaim {
\treadonly teeId: string;
\treadonly badgeId: string;
\treadonly badgeLabel: string | null;
\treadonly axisErrorRad: number;
\treadonly perpendicularErrorPx: number;
\treadonly alongPx: number;
\treadonly direction: -1 | 1;
}

export interface VisibleTeeBadgeRayResolution {
\t/** Every first-intercept claim supported by a visible tee half-rail. */
\treadonly claims: readonly VisibleTeeBadgeRayClaim[];
\t/** Strictly unique tee↔badge claims. Locks are belief; claims remain evidence. */
\treadonly locks: readonly VisibleTeeBadgeRayClaim[];
\t/** Union of every badge touched by POSSIBLE visible-tee testimony. Only a
\t * numbered badge absent from this set is eligible for recovery. */
\treadonly coveredBadgeIds: readonly string[];
\treadonly ambiguousTeeIds: readonly string[];
\treadonly conflictedBadgeIds: readonly string[];
}
""",
'visible ray interfaces')

# Width projection: the rail line + known course-local pad width determines a
# centerline. The legal residual is only the measured width/rail/raster error
# budget, NOT another half-pad-wide corridor.
once(
"""\thalfWidth: number,
\thalfHeight: number,
\tthickness: number
): RecoveryFit | undefined {
""",
"""\thalfWidth: number,
\thalfHeight: number,
\thalfHeightErrorPx: number,
\tthickness: number
): RecoveryFit | undefined {
""",
'projectRailFit signature')

once(
"""\tconst badgeX = target.cxPx;
\tconst badgeY = target.cyPx - viewportTopPx;
\tconst badgeNormalFromRail = (badgeX - exact.cx) * nx + (badgeY - exact.cy) * ny;
\tconst plusError = Math.abs(badgeNormalFromRail - halfHeight);
\tconst minusError = Math.abs(badgeNormalFromRail + halfHeight);
\tconst side = plusError <= minusError ? 1 : -1;
\tconst perpendicularError = Math.min(plusError, minusError);
\tconst laneHalfWidth = halfHeight + RASTER_TOLERANCE_PX;
\tconst perpendicularMiss = Math.max(0, perpendicularError - laneHalfWidth);
\treturn {
\t\tcenterXPx: exact.cx + centerAlong * c + side * halfHeight * nx,
\t\tcenterYPx: exact.cy + centerAlong * ss + side * halfHeight * ny,
""",
"""\tconst badgeX = target.cxPx;
\tconst badgeY = target.cyPx - viewportTopPx;
\tconst badgeNormalFromRail = (badgeX - exact.cx) * nx + (badgeY - exact.cy) * ny;
\t// PCA is centered on the observed bright rail band, not its outer edge.
\t// The center-to-rail distance is therefore half the known outer pad width
\t// minus half the measured course-local border thickness.
\tconst projectedCenterOffsetPx = Math.max(0, halfHeight - Math.max(0, thickness) / 2);
\tconst plusError = Math.abs(badgeNormalFromRail - projectedCenterOffsetPx);
\tconst minusError = Math.abs(badgeNormalFromRail + projectedCenterOffsetPx);
\tconst side = plusError <= minusError ? 1 : -1;
\tconst perpendicularError = Math.min(plusError, minusError);
\t// BUILT-IN ERROR BOUND: already-known pad widths tell us how uncertain the
\t// half-width projection is; observed rail thickness bounds where its true
\t// center can lie; the final raster allowance covers cell quantization.
\tconst railCenterUncertaintyPx = Math.max(RASTER_TOLERANCE_PX, railThickness / 2);
\tconst perpendicularBoundPx = RASTER_TOLERANCE_PX + halfHeightErrorPx + railCenterUncertaintyPx;
\tconst perpendicularMiss = Math.max(0, perpendicularError - perpendicularBoundPx);
\treturn {
\t\tcenterXPx: exact.cx + centerAlong * c + side * projectedCenterOffsetPx * nx,
\t\tcenterYPx: exact.cy + centerAlong * ss + side * projectedCenterOffsetPx * ny,
""",
'rail centerline and bound')

once(
"""\t\tbadgePerpendicularErrorPx: perpendicularError,
\t\tbadgePerpendicularMissPx: perpendicularMiss,
\t\tprojectedLaneWidthPx: halfHeight * 2,
""",
"""\t\tbadgePerpendicularErrorPx: perpendicularError,
\t\tbadgePerpendicularMissPx: perpendicularMiss,
\t\tbadgePerpendicularBoundPx: perpendicularBoundPx,
\t\tprojectedLaneWidthPx: halfHeight * 2,
""",
'rail bound return')

# fitComponent needs the empirical half-width bound and forwards it only to
# rail projection; non-rail fallback is intentionally unchanged.
once(
"""\thalfWidth: number,
\thalfHeight: number,
\tthickness: number
): RecoveryFit {
\tconst projectedRail = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, thickness);
""",
"""\thalfWidth: number,
\thalfHeight: number,
\thalfHeightErrorPx: number,
\tthickness: number
): RecoveryFit {
\tconst projectedRail = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
""",
'fitComponent bound forwarding')

# Derive the bound from what G3 already knows about this course's pad widths.
once(
"""\tconst halfWidth = median(pads.map((pad) => pad.majorPx / 2));
\tconst halfHeight = median(pads.map((pad) => pad.minorPx / 2));
\tconst thickness = supportThickness(tees);
""",
"""\tconst halfWidth = median(pads.map((pad) => pad.majorPx / 2));
\tconst minorWidths = pads.map((pad) => pad.minorPx);
\tconst knownPadWidthPx = median(minorWidths);
\tconst halfHeight = knownPadWidthPx / 2;
\t// P100 deviation is intentionally a bound, not a fitted sigma: every pad
\t// already accepted by G3 is part of the course-local width contract.
\tconst halfHeightErrorPx = minorWidths.length === 0
\t\t? 0
\t\t: Math.max(...minorWidths.map((width) => Math.abs(width - knownPadWidthPx))) / 2;
\tconst thickness = supportThickness(tees);
""",
'course-local width bound')

once(
"fitComponent(seed.pixels, seed.component, target, viewportTopPx, halfWidth, halfHeight, thickness);",
"fitComponent(seed.pixels, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);",
'initial rail fit call')
once(
"fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, thickness);",
"fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);",
'refit rail fit call')

# Multiclaim recovery is DEFER, never local winner selection.
once(
"""\tconst ambiguityLost = candidate.ambiguityLostToBadgeLabel != null;
\tconst accepted = !insufficientSupport && unexplained.length === 0 && !axisRejected && !ambiguityLost;
""",
"""\tconst ambiguity = (candidate.ambiguityWithBadgeLabels?.length ?? 0) > 0;
\tconst accepted = !insufficientSupport && unexplained.length === 0 && !axisRejected && !ambiguity;
""",
'graph multiclaim verdict')

once(
"""\t\t: ambiguityLost
\t\t\t? `${holePrefix}${searchScope}; this exact component set also satisfies the strict predicate for badge ${candidate.ambiguityLostToBadgeLabel}, whose badge-axis angular error is smaller; ambiguity resolved in that badge's favor, never silently dropped`
""",
"""\t\t: ambiguity
\t\t\t? `${holePrefix}${searchScope}; this exact component set also supports badge${candidate.ambiguityWithBadgeLabels!.length === 1 ? '' : 's'} ${candidate.ambiguityWithBadgeLabels!.join(', ')}; multiclaim preserved and every claimant is DEFERRED — G4 selects no local winner`
""",
'graph multiclaim reason')

once(
"""\t\t\t\tbadgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,
\t\t\t\tprojectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
""",
"""\t\t\t\tbadgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,
\t\t\t\tbadgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
\t\t\t\tprojectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
""",
'graph bound values')

once(
"""\t\t\t\t\t\t? `observed rail projected at the known tee width misses the badge center by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px beyond the legal lane (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px)`
""",
"""\t\t\t\t\t\t? `observed rail projected by the known pad width misses the inferred centerline bound by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error bound)`
""",
'rail rejection reason')

once(
"""\t\t\t\t\t\t? `rail projection passes: badge center lies inside the known tee-width lane; no badge-driven pose search was performed`
""",
"""\t\t\t\t\t\t? `rail projection passes: centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px <= built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px bound from known pad width + observed rail + raster error; no badge-driven pose search was performed`
""",
'rail acceptance reason')

# Cross-target ambiguity block: preserve all claimants and reject/defer all.
block_start = s.index('\n\t// Cross-target ambiguity:')
block_end = s.index('\n\treturn { candidates, searchOutcomes, chromeSubtractionNotes };', block_start)
new_block = r'''
	// Cross-target multiclaim: the same physical shard may satisfy more than one
	// numbered badge. G4 has no authority to turn a smaller residual into object
	// identity. Preserve every claimant and DEFER them all; later evidence may
	// resolve the relation without erasing what the shard actually testified.
	const accepted = candidates.filter((candidate) => {
		const support = candidate.fragmentPixels.length;
		const railMiss = candidate.fit.fitKind === 'rail-projection' ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
		return support >= MIN_SHARD_SUPPORT_PIXELS &&
			unexplainedPixels(candidate).length === 0 &&
			(railMiss !== undefined ? railMiss === 0 : (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad);
	});
	const byComponentSet = new Map<string, TeeRecoveryCandidate[]>();
	for (const candidate of accepted) {
		const key = candidate.supportingComponentIds.map((id) => id.split(':')[0]).sort().join('+');
		const bucket = byComponentSet.get(key);
		if (bucket) bucket.push(candidate); else byComponentSet.set(key, [candidate]);
	}
	for (const bucket of byComponentSet.values()) {
		if (bucket.length < 2) continue;
		for (const candidate of bucket) {
			const others = bucket
				.filter((other) => other !== candidate)
				.map((other) => other.badgeLabel ?? other.badgeId ?? 'UNKNOWN')
				.sort();
			const index = candidates.indexOf(candidate);
			if (index >= 0) candidates[index] = { ...candidate, ambiguityWithBadgeLabels: others };
		}
	}
'''
s = s[:block_start] + new_block + s[block_end:]

# G4 targeting uses evidence coverage, not only unique locks.
once(
"""\t\tconst rayResolution = resolveVisibleTeeBadgeRays(tees, badges);
\t\tconst claimedBadgeIds = new Set(rayResolution.claims.map((claim) => claim.badgeId));
\t\tconst numberedBadges = badges.filter((badge) => numberLabel(badge) !== undefined);
\t\tctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
\t\tctx.measure('teeRecovery', 'visibleRayAmbiguousTees', rayResolution.ambiguousTeeIds.length);
\t\tctx.measure('teeRecovery', 'visibleRayConflictedBadges', rayResolution.conflictedBadgeIds.length);
\t\tctx.measure('teeRecovery', 'missingNumberedTees', numberedBadges.length - claimedBadgeIds.size);
\t\tfor (const claim of rayResolution.claims) {
""",
"""\t\tconst rayResolution = resolveVisibleTeeBadgeRays(tees, badges);
\t\tconst coveredBadgeIds = new Set(rayResolution.coveredBadgeIds);
\t\tconst lockedKeys = new Set(rayResolution.locks.map((claim) => `${claim.teeId}|${claim.badgeId}`));
\t\tconst numberedBadges = badges.filter((badge) => numberLabel(badge) !== undefined);
\t\tctx.measure('teeRecovery', 'visibleRayClaims', rayResolution.claims.length);
\t\tctx.measure('teeRecovery', 'visibleRayLocks', rayResolution.locks.length);
\t\tctx.measure('teeRecovery', 'visibleRayCoveredBadges', coveredBadgeIds.size);
\t\tctx.measure('teeRecovery', 'visibleRayAmbiguousTees', rayResolution.ambiguousTeeIds.length);
\t\tctx.measure('teeRecovery', 'visibleRayConflictedBadges', rayResolution.conflictedBadgeIds.length);
\t\tctx.measure('teeRecovery', 'missingNumberedTees', numberedBadges.length - coveredBadgeIds.size);
\t\tfor (const claim of rayResolution.claims) {
""",
'unit coverage setup')

once(
"""\t\t\tctx.overlay('teeRecovery', {
\t\t\t\ttype: 'polyline',
\t\t\t\tpath: [[tee.xPx, tee.yPx], [badge.cxPx, badge.cyPx]],
\t\t\t\tverdict: 'info',
\t\t\t\tvisualRole: 'tee-badge-path',
\t\t\t\tref: `visible-ray-${tee.detId}-${badge.detId}`,
\t\t\t\treason: `visible ${tee.detId} uniquely claims badge ${badge.label ?? badge.detId} by its own undirected pad axis (${(claim.axisErrorRad * 180 / Math.PI).toFixed(3)}° < ${activeAxisLimitDeg}°); no pathfinding or assignment testimony read`
\t\t\t});
""",
"""\t\t\tconst locked = lockedKeys.has(`${claim.teeId}|${claim.badgeId}`);
\t\t\tctx.overlay('teeRecovery', {
\t\t\t\ttype: 'polyline',
\t\t\t\tpath: [[tee.xPx, tee.yPx], [badge.cxPx, badge.cyPx]],
\t\t\t\tverdict: 'info',
\t\t\t\tvisualRole: 'tee-badge-path',
\t\t\t\tref: `visible-ray-${tee.detId}-${badge.detId}`,
\t\t\t\treason: locked
\t\t\t\t\t? `LOCK: visible ${tee.detId} has one first-intercept badge and badge ${badge.label ?? badge.detId} has one visible-tee claimant; perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px; no pathfinding or assignment testimony read`
\t\t\t\t\t: `POSSIBLE: visible ${tee.detId} supplies first-intercept testimony for badge ${badge.label ?? badge.detId} (perpendicular corridor error ${claim.perpendicularErrorPx.toFixed(3)}px); multiclaim/conflict is preserved as coverage, not erased into a false recovery target`
\t\t\t});
""",
'visible claim receipts')

once(
"""\t\tif (claimedBadgeIds.size === numberedBadges.length) {
""",
"""\t\tif (coveredBadgeIds.size === numberedBadges.length) {
""",
'coverage early return')

once(
"""\t\tconst localRayClaims: TeeRecoveryAssignmentContext = {
\t\t\tassignments: [...claimedBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray' }))
\t\t};
""",
"""\t\tconst localRayClaims: TeeRecoveryAssignmentContext = {
\t\t\tassignments: [...coveredBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray-coverage' }))
\t\t};
""",
'coverage adapter')

# Make the legacy adapter comments semantically honest.
s = s.replace('which numbered badges are already claimed. These rows are produced locally', 'which numbered badges already have visible-tee coverage. These rows are produced locally')
s = s.replace('const claimedBadgeIds = new Set(search.assignment?.assignments.map((row) => row.badgeId) ?? []);\n\tconst targets = badges.filter((badge) => numberLabel(badge) !== undefined && !claimedBadgeIds.has(badge.detId));', 'const coveredBadgeIds = new Set(search.assignment?.assignments.map((row) => row.badgeId) ?? []);\n\tconst targets = badges.filter((badge) => numberLabel(badge) !== undefined && !coveredBadgeIds.has(badge.detId));')

# Receipts: expose the actual bound next to error/miss.
once(
"""\t\t\t\t\tctx.overlay('teeRecovery', { type: 'polyline', path: [foot, [badge.cxPx, badge.cyPx]], verdict: (candidate.fit.badgePerpendicularMissPx ?? Infinity) > 0 ? 'rejected' : 'info', visualRole: 'tee-badge-path', ref: `${result.id}:perpendicular-residual`, reason: `rail projection perpendicular centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px; outside-lane miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });
""",
"""\t\t\t\t\tctx.overlay('teeRecovery', { type: 'polyline', path: [foot, [badge.cxPx, badge.cyPx]], verdict: (candidate.fit.badgePerpendicularMissPx ?? Infinity) > 0 ? 'rejected' : 'info', visualRole: 'tee-badge-path', ref: `${result.id}:perpendicular-residual`, reason: `rail projection centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px vs built-in known-width error bound ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px; excess miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });
""",
'projection residual receipt')

# Aggregate the new pixel metric when an accepted rail actually participates.
once(
"""\t\t\tif (result.values.badgeAxisErrorRad !== undefined) ctx.measure('teeRecovery', 'axisErrorDeg', result.values.badgeAxisErrorRad * 180 / Math.PI);
""",
"""\t\t\tif (result.values.badgeAxisErrorRad !== undefined) ctx.measure('teeRecovery', 'axisErrorDeg', result.values.badgeAxisErrorRad * 180 / Math.PI);
\t\t\tif (result.values.badgePerpendicularErrorPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularErrorPx', result.values.badgePerpendicularErrorPx);
\t\t\tif (result.values.badgePerpendicularBoundPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularBoundPx', result.values.badgePerpendicularBoundPx);
\t\t\tif (result.values.badgePerpendicularMissPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularMissPx', result.values.badgePerpendicularMissPx);
""",
'projection aggregate measurements')

# Feature text should say zero coverage, not unique-lock absence.
s = s.replace('only ray-unclaimed badges enter shard recovery', 'only badges with zero visible-tee ray coverage enter shard recovery')

p.write_text(s)
print(f'patched {p}')
