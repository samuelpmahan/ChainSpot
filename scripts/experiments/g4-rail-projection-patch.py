from pathlib import Path

p = Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s = p.read_text()


def replace_once(old: str, new: str, name: str) -> None:
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{name}: expected one match, got {n}')
    s = s.replace(old, new, 1)


replace_once(
    """\treadonly angleRad: number;\n\t/** Width of the observed course-local support band.  This is derived from\n\t * the intact pads' area, not from a renderer/template constant. */\n\treadonly supportThicknessPx?: number;\n""",
    """\treadonly angleRad: number;\n\t/** Width of the observed course-local support band.  This is derived from\n\t * the intact pads' area, not from a renderer/template constant. */\n\treadonly supportThicknessPx?: number;\n\t/** Rail projection is determined by observed pixels + known tee size. */\n\treadonly fitKind?: 'support-search' | 'rail-projection';\n\treadonly badgePerpendicularErrorPx?: number;\n\treadonly badgePerpendicularMissPx?: number;\n\treadonly projectedLaneWidthPx?: number;\n\treadonly observedRailSpanPx?: number;\n""",
    'RecoveryFit fields',
)

replace_once(
    """\treadonly fullSpanComponentLocalization?: number;\n}\n""",
    """\treadonly fullSpanComponentLocalization?: number;\n\treadonly badgePerpendicularErrorPx?: number;\n\treadonly badgePerpendicularMissPx?: number;\n\treadonly projectedLaneWidthPx?: number;\n\treadonly observedRailSpanPx?: number;\n\treadonly railProjection?: number;\n}\n""",
    'TeeRecoveryValues fields',
)

# Visible tee ownership: use measured tee width as a projected lane, not an angle cone.
start = s.index('export function resolveVisibleTeeBadgeRays(')
end = s.index('\nfunction exactBasketPixels(', start)
s = s[:start] + r'''export function resolveVisibleTeeBadgeRays(
	tees: readonly TeeEvidence[],
	badges: readonly BadgeEvidence[]
): VisibleTeeBadgeRayResolution {
	const numbered = badges.filter((badge) => numberLabel(badge) !== undefined);
	const proposals: VisibleTeeBadgeRayClaim[] = [];
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
					axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx))
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
		if (firstIntercepts.length === 1) proposals.push(firstIntercepts[0]!);
		else if (firstIntercepts.length > 1) ambiguousTeeIds.push(tee.detId);
	}

	const byBadge = new Map<string, VisibleTeeBadgeRayClaim[]>();
	for (const proposal of proposals) {
		const bucket = byBadge.get(proposal.badgeId);
		if (bucket) bucket.push(proposal);
		else byBadge.set(proposal.badgeId, [proposal]);
	}
	const claims: VisibleTeeBadgeRayClaim[] = [];
	const conflictedBadgeIds: string[] = [];
	for (const [badgeId, bucket] of byBadge) {
		if (bucket.length === 1) claims.push(bucket[0]!);
		else conflictedBadgeIds.push(badgeId);
	}
	claims.sort((a, b) => a.badgeId.localeCompare(b.badgeId) || a.teeId.localeCompare(b.teeId));
	ambiguousTeeIds.sort();
	conflictedBadgeIds.sort();
	return { claims, ambiguousTeeIds, conflictedBadgeIds };
}
''' + s[end:]

marker = """function fitComponent(\n\tpixels: readonly [number, number][],\n\tcomponent: ComponentStats,\n\ttarget: BadgeEvidence,\n\tviewportTopPx: number,\n\thalfWidth: number,\n\thalfHeight: number,\n\tthickness: number\n): RecoveryFit {\n"""
if s.count(marker) != 1:
    raise SystemExit('fitComponent marker drifted')

helper = r'''/**
 * A rail knows its own line. The course-local tee width tells us where the
 * centerline can be. The badge is never allowed to rotate or translate the
 * tee; it contributes only a perpendicular residual against that projection.
 */
function projectRailFit(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	thickness: number
): RecoveryFit | undefined {
	if (pixels.length < 2) return undefined;
	const exact = exactVisibleStats(component.label, pixels) ?? component;
	const angle = exact.angle;
	if (!Number.isFinite(angle)) return undefined;
	const c = Math.cos(angle), ss = Math.sin(angle);
	const nx = -ss, ny = c;
	let minAlong = Infinity, maxAlong = -Infinity;
	let minNormal = Infinity, maxNormal = -Infinity;
	for (const [x, y] of pixels) {
		const dx = x - exact.cx, dy = y - exact.cy;
		const along = dx * c + dy * ss;
		const normal = dx * nx + dy * ny;
		minAlong = Math.min(minAlong, along);
		maxAlong = Math.max(maxAlong, along);
		minNormal = Math.min(minNormal, normal);
		maxNormal = Math.max(maxNormal, normal);
	}
	const railSpan = maxAlong - minAlong;
	const railThickness = maxNormal - minNormal;
	const allowedRailThickness = Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX;
	if (railThickness > allowedRailThickness || railSpan > 2 * halfWidth + 2 * RASTER_TOLERANCE_PX) return undefined;

	const lowCenterAlong = maxAlong - halfWidth;
	const highCenterAlong = minAlong + halfWidth;
	if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) return undefined;
	const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));

	const badgeX = target.cxPx;
	const badgeY = target.cyPx - viewportTopPx;
	const badgeNormalFromRail = (badgeX - exact.cx) * nx + (badgeY - exact.cy) * ny;
	const plusError = Math.abs(badgeNormalFromRail - halfHeight);
	const minusError = Math.abs(badgeNormalFromRail + halfHeight);
	const side = plusError <= minusError ? 1 : -1;
	const perpendicularError = Math.min(plusError, minusError);
	const laneHalfWidth = halfHeight + RASTER_TOLERANCE_PX;
	const perpendicularMiss = Math.max(0, perpendicularError - laneHalfWidth);
	return {
		centerXPx: exact.cx + centerAlong * c + side * halfHeight * nx,
		centerYPx: exact.cy + centerAlong * ss + side * halfHeight * ny,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: angle,
		supportThicknessPx: thickness,
		fitKind: 'rail-projection',
		badgePerpendicularErrorPx: perpendicularError,
		badgePerpendicularMissPx: perpendicularMiss,
		projectedLaneWidthPx: halfHeight * 2,
		observedRailSpanPx: railSpan
	};
}

'''
s = s.replace(marker, helper + marker, 1)

replace_once(
    """\t// A shard centroid is not a tee center. Solve the actual existence question:\n\t// search the small center region capable of containing every visible pixel;\n\t// at each center, constrain the tee major axis to within three degrees of\n\t// the center-to-badge ray and test every pixel against the hollow support.\n\tconst outerRadius = Math.hypot(\n""",
    """\tconst projectedRail = projectRailFit(pixels, component, target, viewportTopPx, halfWidth, halfHeight, thickness);\n\tif (projectedRail) return projectedRail;\n\t// Non-rail fragments retain the legacy full-support feasibility fallback.\n\tconst outerRadius = Math.hypot(\n""",
    'fitComponent rail fast path',
)

replace_once(
    """\t\tangleRad: Math.atan2(badgeY - component.cy, badgeX - component.cx),\n\t\tsupportThicknessPx: thickness\n\t};\n""",
    """\t\tangleRad: Math.atan2(badgeY - component.cy, badgeX - component.cx),\n\t\tsupportThicknessPx: thickness,\n\t\tfitKind: 'support-search'\n\t};\n""",
    'fallback fit kind',
)

replace_once(
    """\t\t\t\tangleRad: badgeRay + axisOffset.rad,\n\t\t\t\tsupportThicknessPx: thickness\n\t\t\t};\n""",
    """\t\t\t\tangleRad: badgeRay + axisOffset.rad,\n\t\t\t\tsupportThicknessPx: thickness,\n\t\t\t\tfitKind: 'support-search'\n\t\t\t};\n""",
    'searched fit kind',
)

replace_once(
    """\tconst axisError = badgeAxisError(candidate);\n\tconst axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\\d+$/.test(candidate.badgeLabel) && (axisError ?? Infinity) >= activeAxisLimitRad;\n""",
    """\tconst axisError = badgeAxisError(candidate);\n\tconst railMissPx = candidate.fit.fitKind === 'rail-projection' ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;\n\tconst axisRejected = candidate.badgeLabel !== null && candidate.badgeLabel !== undefined && /^\\d+$/.test(candidate.badgeLabel) && (\n\t\trailMissPx !== undefined ? railMissPx > 0 : (axisError ?? Infinity) >= activeAxisLimitRad\n\t);\n""",
    'graph rail gate',
)

old_reason = """\t\t: `${holePrefix}${searchScope}; ${insufficientSupport\n\t\t\t\t? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`\n\t\t\t\t: `${axisRejected\n\t\t\t\t\t? `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < ${activeAxisLimitDeg}° (knob axisToleranceDeg; soft ceiling, target P100 5° then ${BADGE_AXIS_TARGET_DEG}°)`\n\t\t\t\t\t: `no hollow tee support fit within ${activeAxisLimitDeg}° of the badge ray explains every visible component pixel (knob axisToleranceDeg; soft ceiling, target P100 5° then ${BADGE_AXIS_TARGET_DEG}°)`}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}`}`;\n"""
new_reason = """\t\t: `${holePrefix}${searchScope}; ${insufficientSupport\n\t\t\t\t? `visible component support ${support} < ${MIN_SHARD_SUPPORT_PIXELS}`\n\t\t\t\t: `${axisRejected\n\t\t\t\t\t? candidate.fit.fitKind === 'rail-projection'\n\t\t\t\t\t\t? `observed rail projected at the known tee width misses the badge center by ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px beyond the legal lane (centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px)`\n\t\t\t\t\t\t: `badge-axis angular error ${(axisError! * 180 / Math.PI).toFixed(3)}° is not < ${activeAxisLimitDeg}° (non-rail fallback only)`\n\t\t\t\t\t: candidate.fit.fitKind === 'rail-projection'\n\t\t\t\t\t\t? `rail projection passes: badge center lies inside the known tee-width lane; no badge-driven pose search was performed`\n\t\t\t\t\t\t: `no hollow tee support fit within ${activeAxisLimitDeg}° of the badge ray explains every visible component pixel (non-rail fallback only)`}${unexplained.length ? pixelEvidence : '; visible component pixels otherwise lie on the fitted support footprint'}`}`;\n"""
replace_once(old_reason, new_reason, 'graph reason')

replace_once(
    """\t\t\t...(axisError === undefined ? {} : { badgeAxisAlignment: Math.cos(axisError), badgeAxisErrorRad: axisError }),\n\t\t\t...(unexplained.length ? { unexplainedVisiblePixels: unexplained.length } : {})\n""",
    """\t\t\t...(axisError === undefined ? {} : { badgeAxisAlignment: Math.cos(axisError), badgeAxisErrorRad: axisError }),\n\t\t\t...(candidate.fit.fitKind === 'rail-projection' ? {\n\t\t\t\tbadgePerpendicularErrorPx: candidate.fit.badgePerpendicularErrorPx ?? Infinity,\n\t\t\t\tbadgePerpendicularMissPx: candidate.fit.badgePerpendicularMissPx ?? Infinity,\n\t\t\t\tprojectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,\n\t\t\t\tobservedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,\n\t\t\t\trailProjection: 1\n\t\t\t} : {}),\n\t\t\t...(unexplained.length ? { unexplainedVisiblePixels: unexplained.length } : {})\n""",
    'graph values',
)

replace_once(
    """\t\t\tconst aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;\n\t\t\tconst aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && aa < activeAxisLimitRad;\n\t\t\tconst bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && ba < activeAxisLimitRad;\n\t\t\tif (aAccepted !== bAccepted) return aAccepted ? -1 : 1;\n\t\t\tif (aAccepted) return b.fragmentPixels.length - a.fragmentPixels.length || aa - ba || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);\n""",
    """\t\t\tconst aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;\n\t\t\tconst aRailMiss = a.fit.fitKind === 'rail-projection' ? a.fit.badgePerpendicularMissPx ?? Infinity : undefined;\n\t\t\tconst bRailMiss = b.fit.fitKind === 'rail-projection' ? b.fit.badgePerpendicularMissPx ?? Infinity : undefined;\n\t\t\tconst aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);\n\t\t\tconst bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);\n\t\t\tif (aAccepted !== bAccepted) return aAccepted ? -1 : 1;\n\t\t\tif (aAccepted) {\n\t\t\t\tconst aResidual = a.fit.fitKind === 'rail-projection' ? a.fit.badgePerpendicularErrorPx ?? Infinity : aa;\n\t\t\t\tconst bResidual = b.fit.fitKind === 'rail-projection' ? b.fit.badgePerpendicularErrorPx ?? Infinity : ba;\n\t\t\t\treturn b.fragmentPixels.length - a.fragmentPixels.length || aResidual - bResidual || a.supportingComponentIds[0]!.localeCompare(b.supportingComponentIds[0]!);\n\t\t\t}\n""",
    'candidate ranking',
)

replace_once(
    """\tconst accepted = candidates.filter((candidate) => {\n\t\tconst support = candidate.fragmentPixels.length;\n\t\treturn support >= MIN_SHARD_SUPPORT_PIXELS &&\n\t\t\tunexplainedPixels(candidate).length === 0 &&\n\t\t\t(badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;\n\t});\n""",
    """\tconst accepted = candidates.filter((candidate) => {\n\t\tconst support = candidate.fragmentPixels.length;\n\t\tconst railMiss = candidate.fit.fitKind === 'rail-projection' ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;\n\t\treturn support >= MIN_SHARD_SUPPORT_PIXELS &&\n\t\t\tunexplainedPixels(candidate).length === 0 &&\n\t\t\t(railMiss !== undefined ? railMiss === 0 : (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad);\n\t});\n""",
    'cross-target accepted',
)

replace_once(
    """\t\tconst ranked = [...bucket].sort((a, b) => (badgeAxisError(a) ?? Infinity) - (badgeAxisError(b) ?? Infinity));\n""",
    """\t\tconst ranked = [...bucket].sort((a, b) => {\n\t\t\tconst ar = a.fit.fitKind === 'rail-projection' ? a.fit.badgePerpendicularErrorPx ?? Infinity : badgeAxisError(a) ?? Infinity;\n\t\t\tconst br = b.fit.fitKind === 'rail-projection' ? b.fit.badgePerpendicularErrorPx ?? Infinity : badgeAxisError(b) ?? Infinity;\n\t\t\treturn ar - br;\n\t\t});\n""",
    'cross-target ranking',
)

anchor = """\t\t\tconst shardPixels = candidate.fragmentPixels.map((point) => localPoint(candidate, point, {}));\n"""
inject = anchor + """\t\t\tif (candidate.fit.fitKind === 'rail-projection' && candidate.badgeId) {\n\t\t\t\tconst badge = badges.find((entry) => entry.detId === candidate.badgeId);\n\t\t\t\tif (badge) {\n\t\t\t\t\tconst fitY = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);\n\t\t\t\t\tconst c = Math.cos(candidate.fit.angleRad), ss = Math.sin(candidate.fit.angleRad);\n\t\t\t\t\tconst nx = -ss, ny = c;\n\t\t\t\t\tconst dx = badge.cxPx - candidate.fit.centerXPx, dy = badge.cyPx - fitY;\n\t\t\t\t\tconst along = dx * c + dy * ss;\n\t\t\t\t\tconst foot: readonly [number, number] = [candidate.fit.centerXPx + along * c, fitY + along * ss];\n\t\t\t\t\tfor (const side of [-1, 1] as const) {\n\t\t\t\t\t\tconst ox = side * candidate.fit.halfHeightPx * nx, oy = side * candidate.fit.halfHeightPx * ny;\n\t\t\t\t\t\tctx.overlay('teeRecovery', { type: 'polyline', path: [[candidate.fit.centerXPx + ox, fitY + oy], [foot[0] + ox, foot[1] + oy]], verdict: 'info', visualRole: 'tee-badge-path', ref: `${result.id}:projected-rail-${side}`, reason: `projected known tee-width boundary; perpendicular badge miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });\n\t\t\t\t\t}\n\t\t\t\t\tctx.overlay('teeRecovery', { type: 'polyline', path: [foot, [badge.cxPx, badge.cyPx]], verdict: (candidate.fit.badgePerpendicularMissPx ?? Infinity) > 0 ? 'rejected' : 'info', visualRole: 'tee-badge-path', ref: `${result.id}:perpendicular-residual`, reason: `rail projection perpendicular centerline error ${(candidate.fit.badgePerpendicularErrorPx ?? Infinity).toFixed(3)}px; outside-lane miss ${(candidate.fit.badgePerpendicularMissPx ?? Infinity).toFixed(3)}px` });\n\t\t\t\t}\n\t\t\t}\n"""
replace_once(anchor, inject, 'rail overlays')

p.write_text(s)
print('patched', p)
