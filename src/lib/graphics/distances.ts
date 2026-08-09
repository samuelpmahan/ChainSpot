/**
 * Real-world hole distances from a planned hole graphic, when a ground scale
 * is known. `feetPerPixel` must come from a source with an actual known
 * ground resolution (currently only `naipMetersPerPixel`, see naip.ts) — it
 * is never guessed or defaulted, so callers that lack one simply omit these.
 */

import type { HoleGraphicPlan, TargetPoint } from '../holeGraphics';

export interface HoleDistances {
	/** Straight-line tee-to-basket distance in feet; null if either point is missing. */
	readonly lengthFt: number | null;
	/** Straight-line distance from the current lie (last shot, else tee) to the basket in feet. */
	readonly distanceToPinFt: number | null;
}

function distancePx(a: TargetPoint, b: TargetPoint): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

export function computeHoleDistances(plan: HoleGraphicPlan, feetPerPixel: number): HoleDistances {
	const lengthFt = plan.tee && plan.basket ? distancePx(plan.tee, plan.basket) * feetPerPixel : null;

	const currentLie = plan.shots.at(-1) ?? plan.tee ?? null;
	const distanceToPinFt =
		currentLie && plan.basket ? distancePx(currentLie, plan.basket) * feetPerPixel : null;

	return { lengthFt, distanceToPinFt };
}
