import type { TeeFrameMeasure } from '../../clean/Tee';

export const FILL_RATIO_TOLERANCE = 1.25;

function logRatio(left: number, right: number): number {
	return Math.abs(Math.log(Math.max(left, Number.EPSILON) / Math.max(right, Number.EPSILON)));
}

/**
 * Experimental fourth family dimension from the historical G3 selector.
 *
 * The clean selector groups enclosing Tee frames by major/minor/area. This
 * variant additionally asks whether their bright-component fill ratios form
 * a common renderer family. It stays separate so a sweep can compare the
 * percepts without silently changing the clean Tee definition.
 */
export function selectFillConsistentTeeFamily(
	measured: readonly TeeFrameMeasure[]
): { readonly members: readonly TeeFrameMeasure[]; readonly anchor: TeeFrameMeasure | null } {
	let members: readonly TeeFrameMeasure[] = [];
	let anchor: TeeFrameMeasure | null = null;
	let bestSpread = Infinity;
	for (const seed of measured) {
		const family = measured.filter(
			(candidate) =>
				logRatio(candidate.frame.major, seed.frame.major) <= Math.log(1.25) &&
				logRatio(candidate.frame.minor, seed.frame.minor) <= Math.log(1.25) &&
				logRatio(candidate.frame.area, seed.frame.area) <= Math.log(1.5) &&
				logRatio(candidate.frame.fill, seed.frame.fill) <= Math.log(FILL_RATIO_TOLERANCE)
		);
		const spread = family.reduce(
			(sum, candidate) =>
				sum +
				logRatio(candidate.frame.major, seed.frame.major) +
				logRatio(candidate.frame.minor, seed.frame.minor) +
				logRatio(candidate.frame.area, seed.frame.area) +
				logRatio(candidate.frame.fill, seed.frame.fill),
			0
		);
		if (family.length > members.length || (family.length === members.length && spread < bestSpread)) {
			members = family;
			anchor = seed;
			bestSpread = spread;
		}
	}
	return {
		members: [...members].sort(
			(left, right) => left.ring.cy - right.ring.cy || left.ring.cx - right.ring.cx
		),
		anchor
	};
}
