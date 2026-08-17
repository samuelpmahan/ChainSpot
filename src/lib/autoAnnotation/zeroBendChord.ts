/**
 * Pure geometric predicate for the 0-bend badge-on-chord structural prior.
 *
 * The port reproduction in `scripts/toph-measure-zerobend.ts` found that the
 * joint predicate matters: distance alone overlaps between straight and bent
 * controls, but distance <=3px together with t in [0.4, 0.6] produced one
 * candidate for 43/44 annotated straight holes and none for 28/28 bent holes.
 * The remaining straight hole safely abstains. A 4px comparison recovered it
 * in the truth-geometry proxy, but did not change the only valid full-pipeline
 * association fixture (DashsTrack), so production conservatively keeps 3px.
 *
 * This file is pure geometry: no pancake-stack types, no imports from
 * rawObjectMask.ts / rawObjectOwnership.ts / p6LowParBasketAssignment.ts.
 */

export interface ZeroBendChordResult {
	readonly onChord: boolean;
	readonly distancePx: number;
	readonly t: number;
}

/**
 * Perpendicular distance from `badge` to the line SEGMENT `tee`->`basket`
 * (standard point-to-segment projection), plus the raw (unclamped)
 * parametric position `t` of `badge`'s projection onto the INFINITE line
 * through `tee`/`basket`.
 *
 * `onChord` is true iff `distancePx <= (opts?.maxDistancePx ?? 3)` AND the
 * raw `t` falls within `[opts?.tMin ?? 0.4, opts?.tMax ?? 0.6]`. `distancePx`
 * is always measured against the closest point on the SEGMENT (t clamped to
 * [0,1] for that purpose only); the returned `t` is unclamped so callers/
 * tests can see e.g. t=0.51. Since the onChord range [0.4,0.6] is always
 * inside [0,1], the segment clamp never affects distance for any t that
 * would pass the onChord check anyway.
 */
export function evaluateZeroBendBadgeOnChord(
	tee: { readonly xPx: number; readonly yPx: number },
	basket: { readonly xPx: number; readonly yPx: number },
	badge: { readonly xPx: number; readonly yPx: number },
	opts?: { readonly maxDistancePx?: number; readonly tMin?: number; readonly tMax?: number }
): ZeroBendChordResult {
	const maxDistancePx = opts?.maxDistancePx ?? 3;
	const tMin = opts?.tMin ?? 0.4;
	const tMax = opts?.tMax ?? 0.6;

	const chordX = basket.xPx - tee.xPx;
	const chordY = basket.yPx - tee.yPx;
	const chordLengthSq = chordX * chordX + chordY * chordY;

	const badgeFromTeeX = badge.xPx - tee.xPx;
	const badgeFromTeeY = badge.yPx - tee.yPx;

	const t = chordLengthSq > 0 ? (badgeFromTeeX * chordX + badgeFromTeeY * chordY) / chordLengthSq : 0;
	const tClamped = Math.min(1, Math.max(0, t));

	const closestX = tee.xPx + tClamped * chordX;
	const closestY = tee.yPx + tClamped * chordY;
	const distancePx = Math.hypot(badge.xPx - closestX, badge.yPx - closestY);

	const onChord = distancePx <= maxDistancePx && t >= tMin && t <= tMax;

	return { onChord, distancePx, t };
}
