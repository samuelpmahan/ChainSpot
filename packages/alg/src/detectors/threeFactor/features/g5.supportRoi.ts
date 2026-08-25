// g5.supportRoi — PARKED, NOT WIRED, NOT REGISTERED.
//
// Kept for two findings in this header that cost real time to establish, and
// for the tested-able pure core below. Deliberately not in registry.ts: the
// owner's call is to finish the algorithm first and optimize afterwards, when
// a review can profile a complete thing instead of a half-built one.
//
// To revive: add to registry.ts, thread `roi` through computeRibbonSupport,
// resolve it in measure.ts's supportField op, add 'badges' to that op's
// consumes.
//
// Restrict support-field computation to a region of interest derived from the
// badges. Default OFF.
//
// WHY: supportField is the most expensive op in the run (~10.5s of ~20s on
// HeritagePark). Its cost is orientations x widths x cells x 12 samples, and
// it computes over the WHOLE raster. On HeritagePark more than half the
// canonical raster contains no course object at all, so most of that work
// feeds cells nothing ever reads.
//
// WHY BADGES AND NOT TEES/BASKETS: the frozen execution order is
//   badgeStage -> badges -> supportField -> badgeOcclusionPatch -> baskets
//   -> tees -> rawPairs -> measurement -> assignment
// supportField runs THIRD. Tees and baskets do not exist yet. Reordering to
// get them would change the run and move the parity hash, so the only object
// evidence available here is the badges from step 2.
//
// THE BET: a badge labels a hole, so the hull of all badges, dilated by a
// margin, should contain every tee and basket. "Should" — this is a bet, not
// a proof, which is exactly why it ships default OFF with an A/B. Turn it on
// and the DashsTrack oracle either still reports 18/18 or it does not.
//
// NOT PURELY AN OPTIMIZATION: normalization takes a percentile over the
// non-zero cells of the raw field. Excluding cells changes which values enter
// that percentile, so `norm` changes, so support values change INSIDE the
// region too. Expect small numeric drift even where the region is generous.
// That is a behavior deviation, not a free speedup, and it is why this is a
// `deviation` feature rather than a knob on g5.ribbon.

import type { BadgeEvidence } from '../types';
import type { ABFeature } from './types';

export const supportRoiFeature = {
	id: 'supportRoi',
	gate: 'G5',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Restrict support-field computation to the badge hull dilated by marginPx. Skipped cells stay 0.',
	knobs: {
		marginPx: {
			default: 200,
			note: 'dilation in IMAGE px around the badge bounding box. Must exceed the greatest distance from any badge to its own tee or basket, or that hole loses its support and its path scoring degrades.',
			validate: (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) && value >= 0
					? null
					: 'marginPx must be a non-negative finite number'
		},
		minBadges: {
			default: 3,
			note: 'below this many badges the hull is not trustworthy and the ROI is abandoned (full-raster computation, identical to OFF).',
			validate: (value: unknown) =>
				typeof value === 'number' && Number.isInteger(value) && value >= 1
					? null
					: 'minBadges must be a positive integer'
		}
	}
} satisfies ABFeature;

/** Inclusive bounds in IMAGE pixels. */
export interface SupportRoi {
	readonly x0: number;
	readonly y0: number;
	readonly x1: number;
	readonly y1: number;
}

/**
 * Pure core, exported for tests. Returns null when the ROI should not be
 * applied — too few badges, or a box that covers the raster anyway, in which
 * case masking would only add overhead.
 */
export function badgeRoi(
	badges: readonly BadgeEvidence[],
	marginPx: number,
	imageWidth: number,
	imageHeight: number,
	minBadges: number
): SupportRoi | null {
	if (badges.length < minBadges) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const badge of badges) {
		const [bx, by, bw, bh] = badge.bbox;
		if (bx < x0) x0 = bx;
		if (by < y0) y0 = by;
		if (bx + bw > x1) x1 = bx + bw;
		if (by + bh > y1) y1 = by + bh;
	}
	if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
	const roi: SupportRoi = {
		x0: Math.max(0, Math.floor(x0 - marginPx)),
		y0: Math.max(0, Math.floor(y0 - marginPx)),
		x1: Math.min(imageWidth - 1, Math.ceil(x1 + marginPx)),
		y1: Math.min(imageHeight - 1, Math.ceil(y1 + marginPx))
	};
	const covered = (roi.x1 - roi.x0 + 1) * (roi.y1 - roi.y0 + 1);
	if (covered >= imageWidth * imageHeight) return null;
	return roi;
}

/** Fraction of the raster the ROI skips, for receipts. */
export function roiSkippedFraction(roi: SupportRoi | null, imageWidth: number, imageHeight: number): number {
	if (roi === null) return 0;
	const kept = (roi.x1 - roi.x0 + 1) * (roi.y1 - roi.y0 + 1);
	return 1 - kept / (imageWidth * imageHeight);
}
