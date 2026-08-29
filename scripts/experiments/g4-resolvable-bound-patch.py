from pathlib import Path

p=Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s=p.read_text()


def once(old: str, new: str, label: str):
    global s
    n=s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 anchor, got {n}')
    s=s.replace(old,new,1)

# Fix the claim-sized receipt loop introduced by the previous experiment.
once('for (let index = 0; index < built.candidates.length; index++) {\n\t\t\tconst candidate = built.claimCandidates[index]!;',
     'for (let index = 0; index < built.claimCandidates.length; index++) {\n\t\t\tconst candidate = built.claimCandidates[index]!;',
     'claim receipt loop')

# Support-membership raster tolerance and localization uncertainty are not the
# same thing. A pixel cell center is at most sqrt(0.5^2+0.5^2) from any point
# inside its cell; use that exact geometric bound for projected localization.
once(
"""const RASTER_TOLERANCE_PX = 1.25;
""",
"""const RASTER_TOLERANCE_PX = 1.25;
/** Maximum Euclidean displacement from an integer pixel center to any point
 * inside that raster cell. Used for localization/error propagation only. */
const RASTER_CENTER_UNCERTAINTY_PX = Math.SQRT1_2;
""",
'raster center bound')

# Tighten the one-rail observation bound from actual finite rail span. Two
# independently uncertain endpoints can differ normally by at most 2 cell
# center bounds, plus the observed rail band's own thickness.
once(
"""\tconst centerNormalBoundPx = Math.max(RASTER_TOLERANCE_PX, thicknessPx / 2);
\tconst halfSpan = Math.max(RASTER_TOLERANCE_PX, spanPx / 2);
\tconst angleBoundRad = Math.atan2(RASTER_TOLERANCE_PX + centerNormalBoundPx, halfSpan);
""",
"""\tconst centerNormalBoundPx = RASTER_CENTER_UNCERTAINTY_PX + thicknessPx / 2;
\tconst endpointNormalDifferenceBoundPx = 2 * RASTER_CENTER_UNCERTAINTY_PX + thicknessPx;
\tconst angleBoundRad = Math.atan2(endpointNormalDifferenceBoundPx, Math.max(1, spanPx));
""",
'observed rail uncertainty')

# The known pad width gives a free information criterion: for one rail, the
# confidence intervals around +offset and -offset must not overlap. If they do,
# the rail cannot even determine which side its tee center occupies.
anchor="""function candidateLocallySupportsBadge(candidate: TeeRecoveryCandidate): boolean {
\tif (candidate.fragmentPixels.length < MIN_SHARD_SUPPORT_PIXELS) return false;
\tif (unexplainedPixels(candidate).length !== 0) return false;
\tif (isRailProjectionFit(candidate.fit)) return (candidate.fit.badgePerpendicularMissPx ?? Infinity) === 0;
\treturn (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
}
"""
new=r'''function oneRailProjectionResolvable(fit: RecoveryFit): boolean {
	if (fit.fitKind === 'rail-pair-projection') return true;
	if (fit.fitKind !== 'rail-projection') return true;
	const projectedCenterOffsetPx = Math.max(
		0,
		fit.halfHeightPx - Math.max(0, fit.supportThicknessPx ?? 0) / 2
	);
	const boundPx = fit.badgePerpendicularBoundPx ?? Infinity;
	// The two candidate tee centerlines are +/- projectedCenterOffsetPx from
	// the observed rail. Their uncertainty intervals are disjoint exactly when
	// bound < offset. No corpus threshold participates.
	return projectedCenterOffsetPx > 0 && boundPx < projectedCenterOffsetPx;
}

function candidateLocallySupportsBadge(candidate: TeeRecoveryCandidate): boolean {
	if (candidate.fragmentPixels.length < MIN_SHARD_SUPPORT_PIXELS) return false;
	if (unexplainedPixels(candidate).length !== 0) return false;
	if (isRailProjectionFit(candidate.fit)) {
		return (candidate.fit.badgePerpendicularMissPx ?? Infinity) === 0 && oneRailProjectionResolvable(candidate.fit);
	}
	return (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
}
'''
once(anchor,new,'promotable rail information bound')

# Use the same predicate when collecting the full evidence graph. Weak rails
# are still present in targetCandidates/searchOutcomes and receipts, but do not
# become semantic object→badge edges.
old="""\t\tfor (const candidate of targetCandidates) {
\t\t\tconst unexplained = unexplainedPixels(candidate).length;
\t\t\tconst axisError = badgeAxisError(candidate) ?? Infinity;
\t\t\tconst railMiss = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst locallyValid = candidate.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS &&
\t\t\t\tunexplained === 0 &&
\t\t\t\t(railMiss !== undefined ? railMiss === 0 : axisError < activeAxisLimitRad);
\t\t\tif (locallyValid) claimCandidates.push(candidate);
\t\t}
"""
new="""\t\tfor (const candidate of targetCandidates) {
\t\t\tif (candidateLocallySupportsBadge(candidate)) claimCandidates.push(candidate);
\t\t}
"""
once(old,new,'claim collection predicate')

# Sort's aAccepted is presentation only, but make it tell the same story.
s=s.replace("const aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);",
            "const aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 && oneRailProjectionResolvable(a.fit) : aa < activeAxisLimitRad);",1)
s=s.replace("const bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);",
            "const bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 && oneRailProjectionResolvable(b.fit) : ba < activeAxisLimitRad);",1)

# Cross-target local-support collection must not resurrect under-informed rails.
old="""\tconst accepted = claimCandidates.filter((candidate) => {
\t\tconst support = candidate.fragmentPixels.length;
\t\tconst railMiss = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\treturn support >= MIN_SHARD_SUPPORT_PIXELS &&
\t\t\tunexplainedPixels(candidate).length === 0 &&
\t\t\t(railMiss !== undefined ? railMiss === 0 : (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad);
\t});
"""
new="""\tconst accepted = claimCandidates.filter(candidateLocallySupportsBadge);
"""
once(old,new,'cross-target predicate')

# graphCandidateResult should say WHY a rail that geometrically touches the
# badge is still insufficient to form a recovery claim.
old="""\tconst railMissPx = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\tconst axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\\d+$/.test(candidate.badgeLabel) && (
\t\trailMissPx !== undefined ? railMissPx > 0 : (axisError ?? Infinity) >= activeAxisLimitRad
\t);
"""
new="""\tconst railMissPx = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\tconst railUnderconstrained = railMissPx !== undefined && !oneRailProjectionResolvable(candidate.fit);
\tconst axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\\d+$/.test(candidate.badgeLabel) && (
\t\trailMissPx !== undefined ? railMissPx > 0 || railUnderconstrained : (axisError ?? Infinity) >= activeAxisLimitRad
\t);
"""
once(old,new,'graph underconstrained rail')

old="""\t\t\t\t\t? railMissPx !== undefined
\t\t\t\t\t\t? `observed rail projected by the known pad width misses the inferred centerline bound by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error bound)`
"""
new="""\t\t\t\t\t? railMissPx !== undefined
\t\t\t\t\t\t? railUnderconstrained
\t\t\t\t\t\t\t? `observed single rail is geometrically compatible but underconstrained: projected ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error interval reaches or crosses the +/- tee-centerline separation implied by known pad width; testimony preserved, recovery DEFERRED`
\t\t\t\t\t\t\t: `observed rail projected by the known pad width misses the inferred centerline bound by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px > built-in ${(candidate.fit.badgePerpendicularBoundPx ?? Infinity).toFixed(3)}px error bound)`
"""
once(old,new,'graph underconstrained reason')

# One-rail bound itself: use the exact raster-center uncertainty rather than
# the wider support-membership allowance. Width spread + rail center + angle
# projection remain explicit and measurable.
once(
"""\tconst perpendicularBoundPx = RASTER_TOLERANCE_PX + halfHeightErrorPx + rail.centerNormalBoundPx + orientationBoundPx;
""",
"""\tconst perpendicularBoundPx = RASTER_CENTER_UNCERTAINTY_PX + halfHeightErrorPx + rail.centerNormalBoundPx + orientationBoundPx;
""",
'one rail bound raster term')

p.write_text(s)
print('patched',p)
