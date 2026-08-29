from pathlib import Path

p = Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s = p.read_text()


def once(old: str, new: str, label: str) -> None:
    global s
    n=s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 anchor, got {n}')
    s=s.replace(old,new,1)

# Provenance for the stronger rail geometry.
once("readonly fitKind?: 'support-search' | 'rail-projection';",
     "readonly fitKind?: 'support-search' | 'rail-projection' | 'rail-pair-projection';",
     'fitKind')
once(
"""\treadonly badgePerpendicularBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
""",
"""\treadonly badgePerpendicularBoundPx?: number;
\treadonly railAngleBoundRad?: number;
\treadonly railSeparationErrorPx?: number;
\treadonly railSeparationBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
""",
'RecoveryFit rail provenance')
once(
"""\treadonly badgePerpendicularBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
\treadonly railProjection?: number;
""",
"""\treadonly badgePerpendicularBoundPx?: number;
\treadonly railAngleBoundRad?: number;
\treadonly railSeparationErrorPx?: number;
\treadonly railSeparationBoundPx?: number;
\treadonly projectedLaneWidthPx?: number;
\treadonly observedRailSpanPx?: number;
\treadonly railProjection?: number;
\treadonly railPairProjection?: number;
""",
'TeeRecoveryValues rail provenance')

# Any rail-derived fit is local geometry; only support-search is the legacy fallback.
insert="""
function isRailProjectionFit(fit: RecoveryFit): boolean {
\treturn fit.fitKind === 'rail-projection' || fit.fitKind === 'rail-pair-projection';
}
"""
once("""function finite(value: number): boolean {
\treturn Number.isFinite(value);
}
""",
"""function finite(value: number): boolean {
\treturn Number.isFinite(value);
}
"""+insert,
'isRailProjectionFit helper')

# Replace the single-rail implementation with an observation primitive, a
# bounded one-rail projection, and a stronger two-rail bracket.
start=s.index('/**\n * A rail knows its own line.')
end=s.index('\nfunction fitComponent(', start)
rail_code=r'''/** A measured border rail, independent of every badge. */
interface RailObservation {
	readonly label: number;
	readonly cx: number;
	readonly cy: number;
	readonly angleRad: number;
	readonly c: number;
	readonly s: number;
	readonly nx: number;
	readonly ny: number;
	readonly spanPx: number;
	readonly thicknessPx: number;
	/** Conservative orientation uncertainty induced by finite rail span and
	 * raster/rail-band uncertainty. This is geometry, not a tuned sigma. */
	readonly angleBoundRad: number;
	readonly centerNormalBoundPx: number;
	readonly pixels: readonly (readonly [number, number])[];
}

function observeRail(
	pixels: readonly (readonly [number, number])[],
	component: ComponentStats,
	halfWidth: number,
	thickness: number
): RailObservation | undefined {
	if (pixels.length < 2) return undefined;
	const exact = exactVisibleStats(component.label, pixels) ?? component;
	const angle = exact.angle;
	if (!Number.isFinite(angle)) return undefined;
	const c = Math.cos(angle), s = Math.sin(angle);
	const nx = -s, ny = c;
	let minAlong = Infinity, maxAlong = -Infinity;
	let minNormal = Infinity, maxNormal = -Infinity;
	for (const [x, y] of pixels) {
		const dx = x - exact.cx, dy = y - exact.cy;
		const along = dx * c + dy * s;
		const normal = dx * nx + dy * ny;
		minAlong = Math.min(minAlong, along);
		maxAlong = Math.max(maxAlong, along);
		minNormal = Math.min(minNormal, normal);
		maxNormal = Math.max(maxNormal, normal);
	}
	const spanPx = maxAlong - minAlong;
	const thicknessPx = maxNormal - minNormal;
	const allowedRailThickness = Math.max(0, thickness) + 2 * RASTER_TOLERANCE_PX;
	if (thicknessPx > allowedRailThickness || spanPx > 2 * halfWidth + 2 * RASTER_TOLERANCE_PX) return undefined;
	const centerNormalBoundPx = Math.max(RASTER_TOLERANCE_PX, thicknessPx / 2);
	const halfSpan = Math.max(RASTER_TOLERANCE_PX, spanPx / 2);
	const angleBoundRad = Math.atan2(RASTER_TOLERANCE_PX + centerNormalBoundPx, halfSpan);
	return {
		label: component.label,
		cx: exact.cx,
		cy: exact.cy,
		angleRad: angle,
		c, s, nx, ny,
		spanPx, thicknessPx,
		angleBoundRad,
		centerNormalBoundPx,
		pixels
	};
}

/**
 * One rail fixes orientation. The known course-local pad width fixes the two
 * possible centerlines. The badge chooses only between those TWO discrete
 * projections and contributes a perpendicular residual; it can never rotate
 * or continuously translate the tee.
 */
function projectRailFit(
	pixels: readonly [number, number][],
	component: ComponentStats,
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number
): RecoveryFit | undefined {
	const rail = observeRail(pixels, component, halfWidth, thickness);
	if (!rail) return undefined;
	let minAlong = Infinity, maxAlong = -Infinity;
	for (const [x, y] of pixels) {
		const along = (x - rail.cx) * rail.c + (y - rail.cy) * rail.s;
		minAlong = Math.min(minAlong, along);
		maxAlong = Math.max(maxAlong, along);
	}
	const lowCenterAlong = maxAlong - halfWidth;
	const highCenterAlong = minAlong + halfWidth;
	if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) return undefined;
	const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));

	const badgeX = target.cxPx;
	const badgeY = target.cyPx - viewportTopPx;
	const badgeNormalFromRail = (badgeX - rail.cx) * rail.nx + (badgeY - rail.cy) * rail.ny;
	// Bright rail PCA is centered in the border band, so its center is t/2
	// inside the pad's outer edge. The known OUTER pad width therefore projects
	// the tee center by halfWidthMinor - t/2.
	const projectedCenterOffsetPx = Math.max(0, halfHeight - Math.max(0, thickness) / 2);
	const plusError = Math.abs(badgeNormalFromRail - projectedCenterOffsetPx);
	const minusError = Math.abs(badgeNormalFromRail + projectedCenterOffsetPx);
	const side = plusError <= minusError ? 1 : -1;
	const perpendicularError = Math.min(plusError, minusError);
	const centerX = rail.cx + centerAlong * rail.c + side * projectedCenterOffsetPx * rail.nx;
	const centerY = rail.cy + centerAlong * rail.s + side * projectedCenterOffsetPx * rail.ny;
	const alongToBadge = Math.abs((badgeX - centerX) * rail.c + (badgeY - centerY) * rail.s);
	const orientationBoundPx = alongToBadge * Math.sin(rail.angleBoundRad);
	// Built-in bound, all measured: P100 course-local pad-width spread + where
	// the rail center can lie inside its raster band + angular uncertainty from
	// finite observed rail span + one final raster-cell allowance.
	const perpendicularBoundPx = RASTER_TOLERANCE_PX + halfHeightErrorPx + rail.centerNormalBoundPx + orientationBoundPx;
	const perpendicularMiss = Math.max(0, perpendicularError - perpendicularBoundPx);
	return {
		centerXPx: centerX,
		centerYPx: centerY,
		halfWidthPx: halfWidth,
		halfHeightPx: halfHeight,
		angleRad: rail.angleRad,
		supportThicknessPx: thickness,
		fitKind: 'rail-projection',
		badgePerpendicularErrorPx: perpendicularError,
		badgePerpendicularMissPx: perpendicularMiss,
		badgePerpendicularBoundPx: perpendicularBoundPx,
		railAngleBoundRad: rail.angleBoundRad,
		projectedLaneWidthPx: halfHeight * 2,
		observedRailSpanPx: rail.spanPx
	};
}

interface RailComponentEntry {
	readonly component: ComponentStats;
	readonly pixels: readonly [number, number][];
}

/**
 * Two parallel border rails are stronger than one: if their measured
 * separation matches the KNOWN pad width (minus the measured border band),
 * they directly bracket the centerline. The badge contributes only its
 * perpendicular residual to that bracketed line.
 */
function projectRailPairFit(
	entries: readonly RailComponentEntry[],
	target: BadgeEvidence,
	viewportTopPx: number,
	halfWidth: number,
	halfHeight: number,
	halfHeightErrorPx: number,
	thickness: number
): { readonly fit: RecoveryFit; readonly labels: readonly number[] } | undefined {
	const observed = entries.flatMap((entry) => {
		const rail = observeRail(entry.pixels, entry.component, halfWidth, thickness);
		return rail ? [{ entry, rail }] : [];
	});
	let best: { fit: RecoveryFit; labels: readonly number[]; separationMiss: number } | undefined;
	for (let i = 0; i < observed.length; i++) for (let j = i + 1; j < observed.length; j++) {
		let a = observed[i]!, b = observed[j]!;
		if (b.rail.spanPx > a.rail.spanPx) [a, b] = [b, a];
		const axisError = undirectedAxisError(a.rail.angleRad, b.rail.angleRad);
		const parallelBound = a.rail.angleBoundRad + b.rail.angleBoundRad;
		if (axisError > parallelBound) continue;
		const dx = b.rail.cx - a.rail.cx;
		const dy = b.rail.cy - a.rail.cy;
		const signedSeparation = dx * a.rail.nx + dy * a.rail.ny;
		const separationPx = Math.abs(signedSeparation);
		const expectedRailCenterSeparationPx = Math.max(0, 2 * halfHeight - Math.max(0, thickness));
		const separationErrorPx = Math.abs(separationPx - expectedRailCenterSeparationPx);
		const alongBetween = Math.abs(dx * a.rail.c + dy * a.rail.s);
		const angularSeparationBoundPx = alongBetween * Math.sin(parallelBound);
		const separationBoundPx = 2 * halfHeightErrorPx + a.rail.centerNormalBoundPx + b.rail.centerNormalBoundPx + RASTER_TOLERANCE_PX + angularSeparationBoundPx;
		if (separationErrorPx > separationBoundPx) continue;

		// Midpoint between the two measured rail centers fixes the centerline in
		// the normal direction. Along-axis center remains bounded by known pad
		// length; choose the primary rail's own center whenever legal.
		const centerBaseX = a.rail.cx + 0.5 * signedSeparation * a.rail.nx;
		const centerBaseY = a.rail.cy + 0.5 * signedSeparation * a.rail.ny;
		let lowCenterAlong = -Infinity, highCenterAlong = Infinity;
		for (const item of [a, b]) for (const [x, y] of item.entry.pixels) {
			const along = (x - centerBaseX) * a.rail.c + (y - centerBaseY) * a.rail.s;
			lowCenterAlong = Math.max(lowCenterAlong, along - halfWidth);
			highCenterAlong = Math.min(highCenterAlong, along + halfWidth);
		}
		if (lowCenterAlong > highCenterAlong + RASTER_TOLERANCE_PX) continue;
		const centerAlong = Math.max(lowCenterAlong, Math.min(highCenterAlong, 0));
		const centerX = centerBaseX + centerAlong * a.rail.c;
		const centerY = centerBaseY + centerAlong * a.rail.s;
		const badgeX = target.cxPx;
		const badgeY = target.cyPx - viewportTopPx;
		const perpendicularError = Math.abs((badgeX - centerX) * a.rail.nx + (badgeY - centerY) * a.rail.ny);
		const alongToBadge = Math.abs((badgeX - centerX) * a.rail.c + (badgeY - centerY) * a.rail.s);
		const orientationBoundPx = alongToBadge * Math.sin(a.rail.angleBoundRad + axisError / 2);
		const centerlineBoundPx = RASTER_TOLERANCE_PX + (a.rail.centerNormalBoundPx + b.rail.centerNormalBoundPx) / 2 + orientationBoundPx;
		const perpendicularMiss = Math.max(0, perpendicularError - centerlineBoundPx);
		const fit: RecoveryFit = {
			centerXPx: centerX,
			centerYPx: centerY,
			halfWidthPx: halfWidth,
			halfHeightPx: halfHeight,
			angleRad: a.rail.angleRad,
			supportThicknessPx: thickness,
			fitKind: 'rail-pair-projection',
			badgePerpendicularErrorPx: perpendicularError,
			badgePerpendicularMissPx: perpendicularMiss,
			badgePerpendicularBoundPx: centerlineBoundPx,
			railAngleBoundRad: a.rail.angleBoundRad + axisError / 2,
			railSeparationErrorPx: separationErrorPx,
			railSeparationBoundPx: separationBoundPx,
			projectedLaneWidthPx: halfHeight * 2,
			observedRailSpanPx: Math.max(a.rail.spanPx, b.rail.spanPx)
		};
		const separationMiss = Math.max(0, separationErrorPx - separationBoundPx);
		if (!best || perpendicularMiss < (best.fit.badgePerpendicularMissPx ?? Infinity) ||
			(perpendicularMiss === (best.fit.badgePerpendicularMissPx ?? Infinity) && separationMiss < best.separationMiss)) {
			best = { fit, labels: [a.entry.component.label, b.entry.component.label].sort((x, y) => x - y), separationMiss };
		}
	}
	return best ? { fit: best.fit, labels: best.labels } : undefined;
}
'''
s=s[:start]+rail_code+s[end:]

# Treat both one-rail and two-rail fits as rail testimony everywhere.
s=s.replace("candidate.fit.fitKind === 'rail-projection'", "isRailProjectionFit(candidate.fit)")
s=s.replace("a.fit.fitKind === 'rail-projection'", "isRailProjectionFit(a.fit)")
s=s.replace("b.fit.fitKind === 'rail-projection'", "isRailProjectionFit(b.fit)")

# Add new numeric custody fields when graphing rail candidates.
once(
"""\t\t\t\tbadgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
\t\t\t\tprojectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
\t\t\t\tobservedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,
\t\t\t\trailProjection: 1
""",
"""\t\t\t\tbadgePerpendicularBoundPx: candidate.fit.badgePerpendicularBoundPx ?? Infinity,
\t\t\t\trailAngleBoundRad: candidate.fit.railAngleBoundRad ?? Infinity,
\t\t\t\trailSeparationErrorPx: candidate.fit.railSeparationErrorPx ?? 0,
\t\t\t\trailSeparationBoundPx: candidate.fit.railSeparationBoundPx ?? 0,
\t\t\t\tprojectedLaneWidthPx: candidate.fit.projectedLaneWidthPx ?? 0,
\t\t\t\tobservedRailSpanPx: candidate.fit.observedRailSpanPx ?? 0,
\t\t\t\trailProjection: 1,
\t\t\t\trailPairProjection: candidate.fit.fitKind === 'rail-pair-projection' ? 1 : 0
""",
'graph rail values')

# Multi-component refit: first ask whether two observed rails directly bracket
# a pad. Only if they do not do we retain the legacy generic union fallback.
old="""\t\t\tif (compatible.length > 1) {
\t\t\t\tfor (let pass = 0; pass < 2; pass++) {
\t\t\t\t\tconst union = compatible.flatMap((entry) => entry.pixels);
\t\t\t\t\tif (union.length === 0) break;
\t\t\t\t\tfit = fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
\t\t\t\t\tconst next = compatibleWith(fit);
\t\t\t\t\tif (next.map((entry) => entry.component.label).join(',') === compatible.map((entry) => entry.component.label).join(',')) break;
\t\t\t\t\tcompatible = next;
\t\t\t\t}
\t\t\t}
"""
new="""\t\t\tif (compatible.length > 1) {
\t\t\t\tconst railPair = projectRailPairFit(compatible, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
\t\t\t\tif (railPair) {
\t\t\t\t\tfit = railPair.fit;
\t\t\t\t\tconst labels = new Set(railPair.labels);
\t\t\t\t\tcompatible = compatible.filter((entry) => labels.has(entry.component.label));
\t\t\t\t} else {
\t\t\t\t\tfor (let pass = 0; pass < 2; pass++) {
\t\t\t\t\t\tconst union = compatible.flatMap((entry) => entry.pixels);
\t\t\t\t\t\tif (union.length === 0) break;
\t\t\t\t\t\tfit = fitComponent(union, seed.component, target, viewportTopPx, halfWidth, halfHeight, halfHeightErrorPx, thickness);
\t\t\t\t\t\tconst next = compatibleWith(fit);
\t\t\t\t\t\tif (next.map((entry) => entry.component.label).join(',') === compatible.map((entry) => entry.component.label).join(',')) break;
\t\t\t\t\t\tcompatible = next;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
"""
once(old,new,'two rail refit seam')

# Current full-span localization should not replace rail-pair center testimony.
once(
"""\t\t\tconst localizationStats = compatible.length === 1 && visibleShards.length === 1
\t\t\t\t? exactVisibleStats(compatible[0]!.component.label, compatible[0]!.pixels)
\t\t\t\t: undefined;
""",
"""\t\t\tconst localizationStats = fit.fitKind !== 'rail-pair-projection' && compatible.length === 1 && visibleShards.length === 1
\t\t\t\t? exactVisibleStats(compatible[0]!.component.label, compatible[0]!.pixels)
\t\t\t\t: undefined;
""",
'pair localization ownership')

# Expose separation/angle bounds in aggregate receipts.
once(
"""\t\t\tif (result.values.badgePerpendicularBoundPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularBoundPx', result.values.badgePerpendicularBoundPx);
\t\t\tif (result.values.badgePerpendicularMissPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularMissPx', result.values.badgePerpendicularMissPx);
""",
"""\t\t\tif (result.values.badgePerpendicularBoundPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularBoundPx', result.values.badgePerpendicularBoundPx);
\t\t\tif (result.values.badgePerpendicularMissPx !== undefined) ctx.measure('teeRecovery', 'badgePerpendicularMissPx', result.values.badgePerpendicularMissPx);
\t\t\tif (result.values.railAngleBoundRad !== undefined) ctx.measure('teeRecovery', 'railAngleBoundDeg', result.values.railAngleBoundRad * 180 / Math.PI);
\t\t\tif (result.values.railSeparationErrorPx !== undefined) ctx.measure('teeRecovery', 'railSeparationErrorPx', result.values.railSeparationErrorPx);
\t\t\tif (result.values.railSeparationBoundPx !== undefined) ctx.measure('teeRecovery', 'railSeparationBoundPx', result.values.railSeparationBoundPx);
""",
'rail aggregate bounds')

# Keep the old soft-ceiling knob legible for the non-rail fallback test/receipt.
s=s.replace('(non-rail fallback only);', '(knob axisToleranceDeg; non-rail fallback only);')
s=s.replace('(non-rail fallback only)`', '(knob axisToleranceDeg; non-rail fallback only)`')

# Visible tee relation: intersect the finite-width half-rail with the ACTUAL
# badge rectangle. A center-point miss is not evidence that the ray missed the badge.
resolver_start=s.index('export function resolveVisibleTeeBadgeRays(')
resolver_end=s.index('\nfunction exactBasketPixels(', resolver_start)
resolver=r'''interface LocalUvPoint { readonly u: number; readonly v: number }

function clipLocalPolygon(
	polygon: readonly LocalUvPoint[],
	a: number,
	b: number,
	c: number
): LocalUvPoint[] {
	if (polygon.length === 0) return [];
	const output: LocalUvPoint[] = [];
	const value = (point: LocalUvPoint) => a * point.u + b * point.v + c;
	for (let index = 0; index < polygon.length; index++) {
		const current = polygon[index]!;
		const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
		const cv = value(current), pv = value(previous);
		const currentInside = cv >= -1e-9, previousInside = pv >= -1e-9;
		if (currentInside !== previousInside) {
			const t = pv / (pv - cv);
			output.push({
				u: previous.u + t * (current.u - previous.u),
				v: previous.v + t * (current.v - previous.v)
			});
		}
		if (currentInside) output.push(current);
	}
	return output;
}

/** Exact convex intersection of a tee's finite-width half-rail with the badge
 * bbox. Returns where that rectangle first enters the half-rail. */
function badgeHalfRailIntersection(
	badge: BadgeEvidence,
	originX: number,
	originY: number,
	c: number,
	s: number,
	halfLane: number,
	halfPad: number,
	direction: -1 | 1
): { readonly alongPx: number; readonly perpendicularErrorPx: number } | undefined {
	const [bx, by, bw, bh] = badge.bbox;
	const corners = [
		[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]
	] as const;
	const local = corners.map(([x, y]) => {
		const dx = x - originX, dy = y - originY;
		return { u: dx * c + dy * s, v: -dx * s + dy * c };
	});
	let clipped = clipLocalPolygon(local, 0, -1, halfLane); // v <= halfLane
	clipped = clipLocalPolygon(clipped, 0, 1, halfLane);     // v >= -halfLane
	clipped = clipLocalPolygon(clipped, direction, 0, -halfPad); // dir*u >= halfPad
	if (clipped.length === 0) return undefined;
	const alongPx = Math.min(...clipped.map((point) => direction * point.u));
	const minV = Math.min(...local.map((point) => point.v));
	const maxV = Math.max(...local.map((point) => point.v));
	const perpendicularErrorPx = minV <= 0 && maxV >= 0 ? 0 : Math.min(Math.abs(minV), Math.abs(maxV));
	return { alongPx, perpendicularErrorPx };
}

export function resolveVisibleTeeBadgeRays(
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
		const halfLane = minorPx / 2 + RASTER_TOLERANCE_PX;
		const halfPad = majorPx / 2;
		const firstIntercepts: VisibleTeeBadgeRayClaim[] = [];
		for (const direction of [-1, 1] as const) {
			const hits = numbered.flatMap((badge) => {
				const hit = badgeHalfRailIntersection(badge, xPx, yPx, c, ss, halfLane, halfPad, direction);
				if (!hit) return [];
				const dx = badge.cxPx - xPx, dy = badge.cyPx - yPx;
				return [{
					claim: {
						teeId: tee.detId,
						badgeId: badge.detId,
						badgeLabel: badge.label,
						axisErrorRad: undirectedAxisError(axisRad, Math.atan2(dy, dx)),
						perpendicularErrorPx: hit.perpendicularErrorPx,
						alongPx: hit.alongPx,
						direction
					} satisfies VisibleTeeBadgeRayClaim,
					alongPx: hit.alongPx
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
s=s[:resolver_start]+resolver+s[resolver_end:]

p.write_text(s)
print('patched', p)
